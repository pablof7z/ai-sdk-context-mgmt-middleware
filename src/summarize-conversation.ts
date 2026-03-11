import type { ContextCompressionDebugInfo } from "./types.js";
import type {
  SummaryFailureMode,
  SummarizeConversationConfig,
  SummarizeConversationResult,
  SummarySpan,
} from "./public-types.js";
import { manageContext } from "./manage-context.js";
import {
  compressionSegmentsToSummarySpans,
  createSummarizerAdapter,
  createSummaryStoreAdapter,
  createTranscriptRendererAdapter,
  dedupeSummarySpans,
  recordsToContextMessages,
  summarySpansToCompressionSegments,
  contextMessagesToRecords,
} from "./public-mappers.js";
import { buildLastResortSummarySpan } from "./summary-failure.js";
import type { SegmentStore } from "./types.js";

function emitDebug(
  onDebug: ((info: ContextCompressionDebugInfo) => void) | undefined,
  info: ContextCompressionDebugInfo
): void {
  if (onDebug) {
    onDebug(info);
  }
}

function createEmptyResult(): SummarizeConversationResult {
  return {
    records: [],
    appliedSummarySpans: [],
    newSummarySpans: [],
    modifications: [],
    stats: {
      originalTokenEstimate: 0,
      postToolPolicyTokenEstimate: 0,
      postSegmentTokenEstimate: 0,
      finalTokenEstimate: 0,
    },
  };
}

async function persistSummarySpans(
  conversationKey: string,
  segmentStore: SegmentStore | undefined,
  appliedSummarySpans: SummarySpan[],
  newSummarySpans: SummarySpan[]
): Promise<void> {
  if (!segmentStore || newSummarySpans.length === 0) {
    return;
  }

  const appliedSegments = summarySpansToCompressionSegments(appliedSummarySpans);
  const newSegments = summarySpansToCompressionSegments(newSummarySpans);

  if (segmentStore.save) {
    await segmentStore.save(conversationKey, appliedSegments);
    return;
  }

  if (segmentStore.append) {
    await segmentStore.append(conversationKey, newSegments);
    return;
  }

  throw new Error("summaryStore must implement save() or append() to persist new summary spans");
}

async function buildFallbackResult(
  config: SummarizeConversationConfig,
  error: Error,
  existingSummarySpans: SummarySpan[],
  segmentStore: SegmentStore | undefined
): Promise<SummarizeConversationResult | undefined> {
  const fallbackSummarySpans = await resolveFailureSummarySpans(config, error, existingSummarySpans);
  if (!fallbackSummarySpans || fallbackSummarySpans.length === 0) {
    return undefined;
  }

  if (segmentStore && config.conversationKey) {
    await persistSummarySpans(
      config.conversationKey,
      segmentStore,
      dedupeSummarySpans([...existingSummarySpans, ...fallbackSummarySpans]),
      fallbackSummarySpans
    );
  }

  const rerun = await manageContext({
    messages: recordsToContextMessages(config.records),
    maxTokens: config.maxTokens,
    compressionThreshold: config.summaryThreshold,
    protectedTailCount: config.preservedTailCount,
    estimator: config.estimator,
    existingSegments: summarySpansToCompressionSegments(
      dedupeSummarySpans([...existingSummarySpans, ...fallbackSummarySpans])
    ),
  });

  return {
    records: contextMessagesToRecords(rerun.messages),
    appliedSummarySpans: compressionSegmentsToSummarySpans(rerun.appliedSegments),
    newSummarySpans: fallbackSummarySpans,
    modifications: rerun.modifications,
    stats: rerun.stats,
  };
}

async function resolveFailureSummarySpans(
  config: SummarizeConversationConfig,
  _error: Error,
  _existingSummarySpans: SummarySpan[]
): Promise<SummarySpan[] | undefined> {
  const summaryFailureMode: SummaryFailureMode = config.summaryFailureMode ?? "throw";
  if (summaryFailureMode !== "last-resort-truncate") {
    return undefined;
  }

  const fallbackSummarySpan = buildLastResortSummarySpan({
    records: config.records,
    maxTokens: config.maxTokens,
    preservedTailCount: config.preservedTailCount ?? 4,
    estimator: config.estimator,
  });

  return fallbackSummarySpan ? [fallbackSummarySpan] : undefined;
}

export async function summarizeConversation(
  config: SummarizeConversationConfig
): Promise<SummarizeConversationResult> {
  const startTime = Date.now();

  if (config.summaryStore && !config.conversationKey) {
    throw new Error("conversationKey is required when summaryStore is configured");
  }

  if (config.records.length === 0) {
    return createEmptyResult();
  }

  const segmentStore = createSummaryStoreAdapter(config.summaryStore, config.existingSummarySpans);
  const loadedSegments = segmentStore && config.conversationKey
    ? (await segmentStore.load(config.conversationKey)) ?? []
    : summarySpansToCompressionSegments(dedupeSummarySpans(config.existingSummarySpans ?? []));
  const existingSummarySpans = compressionSegmentsToSummarySpans(loadedSegments);

  try {
    const managed = await manageContext({
      messages: recordsToContextMessages(config.records),
      maxTokens: config.maxTokens,
      compressionThreshold: config.summaryThreshold,
      protectedTailCount: config.preservedTailCount,
      estimator: config.estimator,
      segmentGenerator: createSummarizerAdapter(config.summarizer),
      transcriptRenderer: createTranscriptRendererAdapter(config.transcriptBuilder),
      existingSegments: loadedSegments,
    });

    let newSummarySpans = compressionSegmentsToSummarySpans(managed.newSegments);

    if (
      newSummarySpans.length === 0 &&
      managed.stats.finalTokenEstimate > config.maxTokens &&
      config.summaryFailureMode === "last-resort-truncate"
    ) {
      const fallbackResult = await buildFallbackResult(
        config,
        new Error("summarizeConversation did not produce summary spans under budget"),
        existingSummarySpans,
        segmentStore
      );
      if (fallbackResult) {
        emitDebug(config.onDebug, {
          originalMessageCount: config.records.length,
          compressedMessageCount: fallbackResult.records.length,
          originalTokenEstimate: fallbackResult.stats.originalTokenEstimate,
          compressedTokenEstimate: fallbackResult.stats.finalTokenEstimate,
          modifications: fallbackResult.modifications,
          appliedSegments: summarySpansToCompressionSegments(fallbackResult.appliedSummarySpans),
          newSegments: summarySpansToCompressionSegments(fallbackResult.newSummarySpans),
          cacheHit: false,
          compressionTimeMs: Date.now() - startTime,
        });
        return fallbackResult;
      }
    }

    if (segmentStore && config.conversationKey) {
      await persistSummarySpans(
        config.conversationKey,
        segmentStore,
        compressionSegmentsToSummarySpans(managed.appliedSegments),
        newSummarySpans
      );
    }

    const result: SummarizeConversationResult = {
      records: contextMessagesToRecords(managed.messages),
      appliedSummarySpans: compressionSegmentsToSummarySpans(managed.appliedSegments),
      newSummarySpans,
      modifications: managed.modifications,
      stats: managed.stats,
    };

    emitDebug(config.onDebug, {
      originalMessageCount: config.records.length,
      compressedMessageCount: result.records.length,
      originalTokenEstimate: result.stats.originalTokenEstimate,
      compressedTokenEstimate: result.stats.finalTokenEstimate,
      modifications: result.modifications,
      appliedSegments: summarySpansToCompressionSegments(result.appliedSummarySpans),
      newSegments: summarySpansToCompressionSegments(result.newSummarySpans),
      cacheHit: false,
      compressionTimeMs: Date.now() - startTime,
    });

    return result;
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const fallbackResult = await buildFallbackResult(
      config,
      normalizedError,
      existingSummarySpans,
      segmentStore
    );

    if (fallbackResult) {
      emitDebug(config.onDebug, {
        originalMessageCount: config.records.length,
        compressedMessageCount: fallbackResult.records.length,
        originalTokenEstimate: fallbackResult.stats.originalTokenEstimate,
        compressedTokenEstimate: fallbackResult.stats.finalTokenEstimate,
        modifications: fallbackResult.modifications,
        appliedSegments: summarySpansToCompressionSegments(fallbackResult.appliedSummarySpans),
        newSegments: summarySpansToCompressionSegments(fallbackResult.newSummarySpans),
        cacheHit: false,
        compressionTimeMs: Date.now() - startTime,
      });
      return fallbackResult;
    }

    throw normalizedError;
  }
}
