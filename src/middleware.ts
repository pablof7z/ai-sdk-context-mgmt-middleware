import type { LanguageModelV3Middleware, LanguageModelV3Message } from "@ai-sdk/provider";
import type {
  ContextManagementConfig,
  ContextDebugInfo,
  CompressionModification,
  CompressionTier,
  CompressionResult,
  TokenEstimator,
  ToolOutputTruncationEvent,
} from "./types.js";
import { createDefaultEstimator } from "./token-estimator.js";
import { applyRuleBasedCompression } from "./rule-based-compressor.js";
import { hashMessages } from "./cache.js";

const objectIdentityMap = new WeakMap<object, number>();
let nextObjectIdentity = 1;

function getObjectIdentity(value: object | undefined): number | undefined {
  if (!value) return undefined;

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

function extractToolCallIds(message: LanguageModelV3Message): string[] {
  if (message.role !== "assistant") return [];

  const content = (message as any).content;
  if (!Array.isArray(content)) return [];

  return content
    .filter((part: any) => part.type === "tool-call" && typeof part.toolCallId === "string")
    .map((part: any) => part.toolCallId);
}

function extractToolResultIds(message: LanguageModelV3Message): string[] {
  if (message.role !== "tool") return [];

  const content = (message as any).content;
  if (!Array.isArray(content)) return [];

  return content
    .filter((part: any) => part.type === "tool-result" && typeof part.toolCallId === "string")
    .map((part: any) => part.toolCallId);
}

function adjustSplitIndexForToolAdjacency(
  messages: LanguageModelV3Message[],
  splitIndex: number
): number {
  let adjustedSplitIndex = splitIndex;

  while (adjustedSplitIndex > 0) {
    const toolCallsInTail = new Set<string>();
    const toolResultsInTail = new Set<string>();

    for (let i = adjustedSplitIndex; i < messages.length; i++) {
      for (const toolCallId of extractToolCallIds(messages[i])) {
        toolCallsInTail.add(toolCallId);
      }
      for (const toolCallId of extractToolResultIds(messages[i])) {
        toolResultsInTail.add(toolCallId);
      }
    }

    const hasDanglingToolResult = Array.from(toolResultsInTail).some(
      (toolCallId) => !toolCallsInTail.has(toolCallId)
    );

    if (!hasDanglingToolResult) {
      break;
    }

    adjustedSplitIndex--;
  }

  return adjustedSplitIndex;
}

function adjustTailSplitForToolAdjacency(
  messages: LanguageModelV3Message[],
  requestedTailCount: number
): number {
  const splitIndex = Math.max(messages.length - requestedTailCount, 0);
  return adjustSplitIndexForToolAdjacency(messages, splitIndex);
}

function createFallbackNotice(): LanguageModelV3Message {
  return {
    role: "user",
    content: [{
      type: "text",
      text: "[Earlier conversation truncated to fit token budget]",
    }],
  };
}

function selectFittingConversationTail(
  messages: LanguageModelV3Message[],
  availableTokens: number,
  estimator: TokenEstimator
): LanguageModelV3Message[] {
  if (availableTokens <= 0 || messages.length === 0) {
    return [];
  }

  let bestStartIndex = messages.length;

  for (let i = messages.length; i >= 0; i--) {
    const candidateStartIndex = adjustSplitIndexForToolAdjacency(messages, i);
    const candidateMessages = messages.slice(candidateStartIndex);
    const candidateTokens = estimator.estimateMessages(candidateMessages);

    if (candidateTokens <= availableTokens) {
      bestStartIndex = candidateStartIndex;
    }
  }

  return messages.slice(bestStartIndex);
}

function enforceTokenBudget(
  systemMessages: LanguageModelV3Message[],
  conversationMessages: LanguageModelV3Message[],
  maxTokens: number,
  estimator: TokenEstimator
): LanguageModelV3Message[] {
  const systemTokens = estimator.estimateMessages(systemMessages);
  const availableConversationTokens = maxTokens - systemTokens;

  if (availableConversationTokens <= 0) {
    return systemMessages;
  }

  let fittedConversation = selectFittingConversationTail(
    conversationMessages,
    availableConversationTokens,
    estimator
  );

  const truncated = fittedConversation.length < conversationMessages.length;
  if (!truncated) {
    return [...systemMessages, ...fittedConversation];
  }

  const notice = createFallbackNotice();
  const noticeTokens = estimator.estimateMessage(notice);

  if (noticeTokens <= availableConversationTokens) {
    const budgetAfterNotice = availableConversationTokens - noticeTokens;
    fittedConversation = selectFittingConversationTail(
      conversationMessages,
      budgetAfterNotice,
      estimator
    );
    return [...systemMessages, notice, ...fittedConversation];
  }

  return [...systemMessages, ...fittedConversation];
}

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
    onToolOutputTruncated,
  } = config;

  const estimator: TokenEstimator = config.estimator || createDefaultEstimator();

  const toolOutput = {
    defaultPolicy: config.toolOutput?.defaultPolicy || "truncate" as const,
    maxTokens: config.toolOutput?.maxTokens || 200,
    recentFullCount: config.toolOutput?.recentFullCount || 2,
    toolOverrides: config.toolOutput?.toolOverrides || {},
  };
  const cacheScope = {
    maxTokens,
    ruleBasedThreshold,
    llmThreshold,
    protectedTailCount,
    toolOutput: {
      ...toolOutput,
      toolOverrides: sortToolOverrides(toolOutput.toolOverrides),
    },
    estimatorId: getObjectIdentity(estimator as object),
    llmCompressorId: getObjectIdentity(llmCompressor as object | undefined),
    truncationHookId: getObjectIdentity(onToolOutputTruncated as object | undefined),
  };

  return {
    specificationVersion: "v3" as const,
    async transformParams({ params, type, model }) {
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
        const cacheKey = hashMessages([cacheScope, `${model.provider}:${model.modelId}`, prompt]);
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
      const tailStartIndex = adjustTailSplitForToolAdjacency(conversationMessages, tailCount);
      const compressibleBody = conversationMessages.slice(0, tailStartIndex);
      const protectedTail = conversationMessages.slice(tailStartIndex);

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

      // Fire onToolOutputTruncated callbacks for tool output modifications
      if (onToolOutputTruncated && modifications.length > 0) {
        for (const mod of modifications) {
          if (
            (mod.type === "tool-output-truncated" || mod.type === "tool-output-removed") &&
            mod.originalText !== undefined
          ) {
            const event: ToolOutputTruncationEvent = {
              toolName: mod.toolName || "unknown",
              toolCallId: mod.toolCallId,
              messageIndex: mod.messageIndex,
              originalOutput: mod.originalText,
              originalTokens: mod.originalTokens,
              removed: mod.type === "tool-output-removed",
            };

            const replacement = await onToolOutputTruncated(event);

            // If callback returns replacement text, update the compressed message
            if (typeof replacement === "string") {
              const msgIdx = mod.messageIndex;
              // Find the corresponding message in compressed array
              // (index may differ if messages were removed, so search by toolCallId)
              for (let j = 0; j < compressed.length; j++) {
                const msg = compressed[j] as any;
                if (msg.role === "tool" && msg.content?.[0]?.toolCallId === mod.toolCallId) {
                  compressed[j] = {
                    ...msg,
                    content: [{
                      ...msg.content[0],
                      content: [{ type: "text", text: replacement }],
                    }],
                  };
                  break;
                }
              }
            }
          }
        }
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
      let finalPrompt = [...systemMessages, ...compressed, ...protectedTail];
      const finalTokenEstimate = estimator.estimateMessages(finalPrompt);

      if (finalTokenEstimate > maxTokens) {
        const budgetEnforcedPrompt = enforceTokenBudget(
          systemMessages,
          [...compressed, ...protectedTail],
          maxTokens,
          estimator
        );

        const enforcedTokens = estimator.estimateMessages(budgetEnforcedPrompt);
        if (enforcedTokens < finalTokenEstimate) {
          modifications.push({
            type: "message-removed",
            messageIndex: 0,
            originalTokens: finalTokenEstimate,
            compressedTokens: enforcedTokens,
          });
          finalPrompt = budgetEnforcedPrompt;
          if (tier === "none") {
            tier = "rule-based";
          }
        }
      }

      // Cache the result
      const result: CompressionResult = {
        messages: finalPrompt,
        tier,
        modifications,
        originalTokenEstimate: totalTokens,
        compressedTokenEstimate: estimator.estimateMessages(finalPrompt),
      };

      if (cache) {
        const cacheKey = hashMessages([cacheScope, `${model.provider}:${model.modelId}`, prompt]);
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
