import type {
  ContextCompressionConfig,
  ContextCompressionDebugInfo,
  ContextCompressionResult,
  ToolContentTruncationEvent,
} from "./types.js";
import { createDefaultEstimator } from "./token-estimator.js";
import { hashValue } from "./cache.js";
import { contextMessagesToMessages, messagesToContextMessages } from "./messages.js";
import { manageContext } from "./manage-context.js";

const objectIdentityMap = new WeakMap<object, number>();
let nextObjectIdentity = 1;

function getObjectIdentity(value: object | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const existing = objectIdentityMap.get(value);
  if (existing !== undefined) {
    return existing;
  }

  const identity = nextObjectIdentity++;
  objectIdentityMap.set(value, identity);
  return identity;
}

function emitDebug(
  onDebug: ((info: ContextCompressionDebugInfo) => void) | undefined,
  info: ContextCompressionDebugInfo
): void {
  if (onDebug) {
    onDebug(info);
  }
}

function buildCacheScope(config: ContextCompressionConfig): Record<string, unknown> {
  return {
    maxTokens: config.maxTokens,
    compressionThreshold: config.compressionThreshold ?? 0.8,
    protectedTailCount: config.protectedTailCount ?? 4,
    priorContextTokens: config.priorContextTokens ?? 0,
    estimatorId: getObjectIdentity(config.estimator as object | undefined),
    toolPolicyId: getObjectIdentity(config.toolPolicy as object | undefined),
    beforeToolCompressionId: getObjectIdentity(config.beforeToolCompression as object | undefined),
    segmentGeneratorId: getObjectIdentity(config.segmentGenerator as object | undefined),
    transcriptRendererId: getObjectIdentity(config.transcriptRenderer as object | undefined),
    segmentStoreId: getObjectIdentity(config.segmentStore as object | undefined),
    retrievalToolName: config.retrievalToolName ?? null,
    retrievalToolArgName: config.retrievalToolArgName ?? "id",
  };
}

function createRetrievalPlaceholderFactory(config: ContextCompressionConfig) {
  if (!config.retrievalToolName) {
    return undefined;
  }

  const argName = config.retrievalToolArgName ?? "id";

  return (event: ToolContentTruncationEvent): string => {
    const target = event.entryType === "tool-call" ? "input" : "output";
    return `[Tool ${target} truncated. Use ${config.retrievalToolName}(${argName}=${JSON.stringify(event.messageId)}) to retrieve the full ${target}.]`;
  };
}

async function persistSegments(
  conversationKey: string,
  config: ContextCompressionConfig,
  appliedSegments: ContextCompressionResult["appliedSegments"],
  newSegments: ContextCompressionResult["newSegments"]
): Promise<void> {
  if (!config.segmentStore || newSegments.length === 0) {
    return;
  }

  if (config.segmentStore.save) {
    await config.segmentStore.save(conversationKey, appliedSegments);
    return;
  }

  if (config.segmentStore.append) {
    await config.segmentStore.append(conversationKey, newSegments);
    return;
  }

  throw new Error("segmentStore must implement save() or append() to persist new segments");
}

export async function contextCompression(
  config: ContextCompressionConfig
): Promise<ContextCompressionResult> {
  const startTime = Date.now();
  const estimator = config.estimator ?? createDefaultEstimator();
  const cacheScope = buildCacheScope(config);

  if (config.segmentStore && !config.conversationKey) {
    throw new Error("conversationKey is required when segmentStore is configured");
  }

  if (config.messages.length === 0) {
    return {
      messages: [],
      appliedSegments: [],
      newSegments: [],
      modifications: [],
      stats: {
        originalTokenEstimate: 0,
        postToolPolicyTokenEstimate: 0,
        postSegmentTokenEstimate: 0,
        finalTokenEstimate: 0,
      },
    };
  }

  const existingSegments = config.segmentStore && config.conversationKey
    ? (await config.segmentStore.load(config.conversationKey)) ?? []
    : [];

  const normalizedMessages = messagesToContextMessages(config.messages);
  const originalTokenEstimate = estimator.estimateMessages(normalizedMessages);
  const cacheKey = config.cache
    ? hashValue([
      cacheScope,
      config.conversationKey ?? null,
      existingSegments,
      config.messages,
    ])
    : undefined;

  if (cacheKey && config.cache) {
    const cached = config.cache.get(cacheKey);
    if (cached) {
      const result: ContextCompressionResult = {
        ...cached,
        newSegments: [],
      };

      emitDebug(config.onDebug, {
        originalMessageCount: config.messages.length,
        compressedMessageCount: result.messages.length,
        originalTokenEstimate,
        compressedTokenEstimate: result.stats.finalTokenEstimate,
        modifications: result.modifications,
        appliedSegments: result.appliedSegments,
        newSegments: [],
        cacheHit: true,
        compressionTimeMs: Date.now() - startTime,
      });

      return result;
    }
  }

  const managed = await manageContext({
    messages: normalizedMessages,
    maxTokens: config.maxTokens,
    compressionThreshold: config.compressionThreshold,
    protectedTailCount: config.protectedTailCount,
    priorContextTokens: config.priorContextTokens,
    estimator,
    segmentGenerator: config.segmentGenerator,
    transcriptRenderer: config.transcriptRenderer,
    existingSegments,
    toolPolicy: config.toolPolicy,
    beforeToolCompression: config.beforeToolCompression,
    onToolContentTruncated: createRetrievalPlaceholderFactory(config),
  });

  if (config.segmentStore && config.conversationKey) {
    await persistSegments(config.conversationKey, config, managed.appliedSegments, managed.newSegments);
  }

  const result: ContextCompressionResult = {
    messages: contextMessagesToMessages(managed.messages),
    appliedSegments: managed.appliedSegments,
    newSegments: managed.newSegments,
    modifications: managed.modifications,
    stats: managed.stats,
  };

  if (cacheKey && config.cache) {
    config.cache.set(cacheKey, result);
  }

  emitDebug(config.onDebug, {
    originalMessageCount: config.messages.length,
    compressedMessageCount: result.messages.length,
    originalTokenEstimate: result.stats.originalTokenEstimate,
    compressedTokenEstimate: result.stats.finalTokenEstimate,
    modifications: result.modifications,
    appliedSegments: result.appliedSegments,
    newSegments: result.newSegments,
    cacheHit: false,
    compressionTimeMs: Date.now() - startTime,
  });

  return result;
}
