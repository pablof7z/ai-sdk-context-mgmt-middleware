import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import type {
  ContextManagementConfig,
  ContextDebugInfo,
  ManageContextResult,
  MiddlewareContext,
} from "./types.js";
import { promptToContextMessages, contextMessagesToPrompt } from "./messages.js";
import { manageContext } from "./manage-context.js";
import { createDefaultEstimator } from "./token-estimator.js";
import { hashValue } from "./cache.js";

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

function sortToolOverrides(toolOverrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(toolOverrides).sort(([left], [right]) => left.localeCompare(right))
  );
}

function emitDebug(onDebug: ((info: ContextDebugInfo) => void) | undefined, info: ContextDebugInfo): void {
  if (onDebug) {
    onDebug(info);
  }
}

function buildCacheScope(config: ContextManagementConfig): Record<string, unknown> {
  return {
    maxTokens: config.maxTokens,
    compressionThreshold: config.compressionThreshold ?? 0.8,
    protectedTailCount: config.protectedTailCount ?? 4,
    toolOutput: {
      defaultPolicy: config.toolOutput?.defaultPolicy ?? "truncate",
      maxTokens: config.toolOutput?.maxTokens ?? 200,
      recentFullCount: config.toolOutput?.recentFullCount ?? 2,
      toolOverrides: sortToolOverrides(config.toolOutput?.toolOverrides ?? {}),
    },
    estimatorId: getObjectIdentity(config.estimator as object | undefined),
    segmentGeneratorId: getObjectIdentity(config.segmentGenerator as object | undefined),
    transcriptRendererId: getObjectIdentity(config.transcriptRenderer as object | undefined),
    segmentStoreId: getObjectIdentity(config.segmentStore as object | undefined),
    truncationHookId: getObjectIdentity(config.onToolOutputTruncated as object | undefined),
  };
}

async function persistSegments(
  conversationKey: string,
  config: ContextManagementConfig,
  appliedSegments: ManageContextResult["appliedSegments"],
  newSegments: ManageContextResult["newSegments"]
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

export function createContextManagementMiddleware(
  config: ContextManagementConfig
): LanguageModelV3Middleware {
  const estimator = config.estimator ?? createDefaultEstimator();
  const cacheScope = buildCacheScope(config);

  return {
    specificationVersion: "v3",
    async transformParams({ params, type, model }) {
      const startTime = Date.now();
      const prompt = params.prompt;

      if (!prompt || prompt.length === 0) {
        return params;
      }

      const middlewareContext: MiddlewareContext = {
        params: params as MiddlewareContext["params"],
        type,
        model: {
          provider: model.provider,
          modelId: model.modelId,
        },
      };

      const conversationKey = config.segmentStore
        ? config.resolveConversationKey?.(middlewareContext)
        : undefined;

      if (config.segmentStore && !conversationKey) {
        throw new Error("resolveConversationKey is required when segmentStore is configured");
      }

      const existingSegments = conversationKey && config.segmentStore
        ? (await config.segmentStore.load(conversationKey)) ?? []
        : [];
      const normalizedMessages = promptToContextMessages(prompt);
      const cacheKey = config.cache
        ? hashValue([
          cacheScope,
          `${model.provider}:${model.modelId}`,
          conversationKey ?? null,
          existingSegments,
          normalizedMessages,
        ])
        : undefined;

      if (cacheKey && config.cache) {
        const cached = config.cache.get(cacheKey);
        if (cached) {
          emitDebug(config.onDebug, {
            originalMessageCount: prompt.length,
            compressedMessageCount: cached.messages.length,
            originalTokenEstimate: estimator.estimateMessages(normalizedMessages),
            compressedTokenEstimate: cached.stats.finalTokenEstimate,
            modifications: cached.modifications,
            appliedSegments: cached.appliedSegments,
            newSegments: [],
            cacheHit: true,
            compressionTimeMs: Date.now() - startTime,
          });

          return {
            ...params,
            prompt: contextMessagesToPrompt(cached.messages),
          };
        }
      }

      const result = await manageContext({
        messages: normalizedMessages,
        maxTokens: config.maxTokens,
        compressionThreshold: config.compressionThreshold,
        protectedTailCount: config.protectedTailCount,
        estimator,
        segmentGenerator: config.segmentGenerator,
        transcriptRenderer: config.transcriptRenderer,
        existingSegments,
        toolOutput: config.toolOutput,
        onToolOutputTruncated: config.onToolOutputTruncated,
      });

      if (conversationKey) {
        await persistSegments(conversationKey, config, result.appliedSegments, result.newSegments);
      }

      if (cacheKey && config.cache) {
        config.cache.set(cacheKey, result);
      }

      emitDebug(config.onDebug, {
        originalMessageCount: prompt.length,
        compressedMessageCount: result.messages.length,
        originalTokenEstimate: result.stats.originalTokenEstimate,
        compressedTokenEstimate: result.stats.finalTokenEstimate,
        modifications: result.modifications,
        appliedSegments: result.appliedSegments,
        newSegments: result.newSegments,
        cacheHit: false,
        compressionTimeMs: Date.now() - startTime,
      });

      return {
        ...params,
        prompt: contextMessagesToPrompt(result.messages),
      };
    },
  };
}

export const contextManagement = createContextManagementMiddleware;
