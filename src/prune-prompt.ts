import type {
  PrunePromptConfig,
  PrunePromptResult,
} from "./public-types.js";
import { contextCompression } from "./context-compression.js";
import {
  compressionSegmentsToSummarySpans,
  createSummaryStoreAdapter,
} from "./public-mappers.js";
import type {
  CompressionCache,
  ContextCompressionConfig,
  ContextCompressionResult,
} from "./types.js";

export async function prunePrompt(config: PrunePromptConfig): Promise<PrunePromptResult> {
  const segmentStore = createSummaryStoreAdapter(config.summaryStore, config.existingSummarySpans);
  const internalConfig: ContextCompressionConfig = {
    messages: config.messages,
    maxTokens: config.maxTokens,
    compressionThreshold: config.pruningThreshold,
    protectedTailCount: config.preservedTailCount,
    priorContextTokens: config.priorContextTokens,
    estimator: config.estimator,
    segmentStore,
    conversationKey: config.conversationKey ?? (segmentStore ? "__inline__" : undefined),
    cache: config.cache as CompressionCache<ContextCompressionResult> | undefined,
    toolPolicy: config.promptToolPolicy,
    retrievalToolName: config.retrievalToolName,
    retrievalToolArgName: config.retrievalToolArgName,
    onDebug: config.onDebug,
  };

  const result = await contextCompression(internalConfig);

  return {
    messages: result.messages,
    appliedSummarySpans: compressionSegmentsToSummarySpans(result.appliedSegments),
    newSummarySpans: compressionSegmentsToSummarySpans(result.newSegments),
    modifications: result.modifications,
    stats: result.stats,
  };
}
