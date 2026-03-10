import type { LanguageModelV3Middleware, LanguageModelV3Message } from "@ai-sdk/provider";
import type {
  ContextManagementConfig,
  ContextDebugInfo,
  CompressionModification,
  CompressionTier,
  CompressionResult,
  TokenEstimator,
} from "./types.js";
import { createDefaultEstimator } from "./token-estimator.js";
import { applyRuleBasedCompression } from "./rule-based-compressor.js";
import { hashMessages } from "./cache.js";

/**
 * Create the context management middleware.
 *
 * This middleware intercepts `transformParams` to apply a two-tier
 * compression pipeline to the conversation when token usage exceeds
 * configured thresholds:
 *
 * - **Tier 1 (Rule-based):** Tool output decay, truncation, removal
 * - **Tier 2 (LLM-assisted):** Conversation summarization via external LLM
 *
 * The last N messages (protectedTailCount) are always preserved intact.
 */
export function contextManagement(config: ContextManagementConfig): LanguageModelV3Middleware {
  const {
    maxTokens,
    ruleBasedThreshold = 0.8,
    llmThreshold = 0.95,
    protectedTailCount = 4,
    llmCompressor,
    cache,
    onDebug,
  } = config;

  const estimator: TokenEstimator = config.estimator || createDefaultEstimator();

  const toolOutput = {
    defaultPolicy: config.toolOutput?.defaultPolicy || "truncate" as const,
    maxTokens: config.toolOutput?.maxTokens || 200,
    recentFullCount: config.toolOutput?.recentFullCount || 2,
    toolOverrides: config.toolOutput?.toolOverrides || {},
  };

  return {
    specificationVersion: "v3" as const,
    async transformParams({ params, type }) {
      const startTime = Date.now();
      const prompt = params.prompt as LanguageModelV3Message[];

      if (!prompt || prompt.length === 0) {
        return params;
      }

      // Separate system messages from conversation
      const systemMessages: LanguageModelV3Message[] = [];
      const conversationMessages: LanguageModelV3Message[] = [];

      for (const msg of prompt) {
        if (msg.role === "system") {
          systemMessages.push(msg);
        } else {
          conversationMessages.push(msg);
        }
      }

      const systemTokens = estimator.estimateMessages(systemMessages);
      const conversationTokens = estimator.estimateMessages(conversationMessages);
      const totalTokens = systemTokens + conversationTokens;

      // Check cache
      if (cache) {
        const cacheKey = hashMessages(prompt);
        const cached = cache.get(cacheKey);
        if (cached) {
          emitDebug(onDebug, {
            tier: cached.tier,
            originalMessageCount: prompt.length,
            compressedMessageCount: cached.messages.length,
            originalTokenEstimate: totalTokens,
            compressedTokenEstimate: estimator.estimateMessages(cached.messages),
            modifications: cached.modifications,
            cacheHit: true,
            compressionTimeMs: Date.now() - startTime,
          });

          return { ...params, prompt: cached.messages };
        }
      }

      const utilization = totalTokens / maxTokens;

      // Under threshold — no compression needed
      if (utilization <= ruleBasedThreshold) {
        emitDebug(onDebug, {
          tier: "none",
          originalMessageCount: prompt.length,
          compressedMessageCount: prompt.length,
          originalTokenEstimate: totalTokens,
          compressedTokenEstimate: totalTokens,
          modifications: [],
          cacheHit: false,
          compressionTimeMs: Date.now() - startTime,
        });

        return params;
      }

      // Split protected tail from compressible body
      const tailCount = Math.min(protectedTailCount, conversationMessages.length);
      const compressibleBody = conversationMessages.slice(0, conversationMessages.length - tailCount);
      const protectedTail = conversationMessages.slice(conversationMessages.length - tailCount);

      let compressed = compressibleBody;
      let tier: CompressionTier = "none";
      let modifications: CompressionModification[] = [];

      // --- Tier 1: Rule-based compression ---
      if (compressibleBody.length > 0) {
        const ruleResult = applyRuleBasedCompression(compressibleBody, {
          estimator,
          toolOutput,
        });

        compressed = ruleResult.messages;
        modifications = ruleResult.modifications;
        tier = modifications.length > 0 ? "rule-based" : "none";
      }

      // Check if Tier 2 is needed
      const afterTier1Tokens = systemTokens + estimator.estimateMessages(compressed) + estimator.estimateMessages(protectedTail);
      const afterTier1Utilization = afterTier1Tokens / maxTokens;

      // --- Tier 2: LLM-assisted compression ---
      if (afterTier1Utilization > llmThreshold && llmCompressor && compressed.length > 0) {
        try {
          const availableBudget = maxTokens - systemTokens - estimator.estimateMessages(protectedTail);
          const targetTokens = Math.max(Math.floor(availableBudget * 0.5), 50);

          const systemPrompt = systemMessages.length > 0
            ? (typeof systemMessages[0].content === "string" ? systemMessages[0].content : "")
            : undefined;

          const llmResult = await llmCompressor.compress(compressed, targetTokens, { systemPrompt });

          const llmTokens = estimator.estimateMessages(llmResult);
          const originalBodyTokens = estimator.estimateMessages(compressed);

          modifications.push({
            type: "conversation-summarized",
            messageIndex: 0,
            originalTokens: originalBodyTokens,
            compressedTokens: llmTokens,
          });

          compressed = llmResult;
          tier = "llm-assisted";
        } catch (error) {
          // LLM failed — fall back to Tier 1 results
          if (tier === "none") tier = "rule-based";
        }
      }

      // Reassemble: system + compressed body + protected tail
      const finalPrompt = [...systemMessages, ...compressed, ...protectedTail];

      // Cache the result
      const result: CompressionResult = {
        messages: finalPrompt,
        tier,
        modifications,
        originalTokenEstimate: totalTokens,
        compressedTokenEstimate: estimator.estimateMessages(finalPrompt),
      };

      if (cache) {
        const cacheKey = hashMessages(prompt);
        cache.set(cacheKey, result);
      }

      emitDebug(onDebug, {
        tier,
        originalMessageCount: prompt.length,
        compressedMessageCount: finalPrompt.length,
        originalTokenEstimate: totalTokens,
        compressedTokenEstimate: result.compressedTokenEstimate,
        modifications,
        cacheHit: false,
        compressionTimeMs: Date.now() - startTime,
      });

      return { ...params, prompt: finalPrompt };
    },
  };
}

function emitDebug(
  onDebug: ((info: ContextDebugInfo) => void) | undefined,
  info: ContextDebugInfo
): void {
  if (onDebug) {
    try {
      onDebug(info);
    } catch {
      // Never let debug callbacks break the middleware
    }
  }
}
