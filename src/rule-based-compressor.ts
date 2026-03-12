import type {
  BeforeToolCompression,
  CompressionModification,
  ContextMessage,
  TokenEstimator,
  ToolCompressionPlanEntry,
  ToolContentTruncationEvent,
  ToolEntryPolicyDecision,
  ToolEntryType,
  ToolPolicy,
  ToolPolicyContext,
} from "./types.js";

interface ToolPolicyOptions {
  estimator: TokenEstimator;
  currentTokenEstimate: number;
  maxContextTokens: number;
  toolPolicy?: ToolPolicy;
  beforeToolCompression?: BeforeToolCompression;
  onToolContentTruncated?: (
    event: ToolContentTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>;
  onToolOutputTruncated?: (
    event: ToolContentTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>;
}

interface ToolPolicyResult {
  messages: ContextMessage[];
  modifications: CompressionModification[];
  tokenEstimate: number;
}

interface ToolExchangeContextInternal extends ToolPolicyContext {
  key: string;
}

function getExchangeKey(message: ContextMessage): string {
  if (message.toolCallId) {
    return message.toolCallId;
  }

  return `${message.id}:${message.entryType}`;
}



function buildToolExchanges(
  messages: ContextMessage[],
  estimator: TokenEstimator,
  currentTokenEstimate: number,
  maxContextTokens: number
): Map<string, ToolExchangeContextInternal> {
  const exchanges = new Map<string, ToolExchangeContextInternal>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.entryType !== "tool-call" && message.entryType !== "tool-result") {
      continue;
    }

    const key = getExchangeKey(message);
    const existing = exchanges.get(key) ?? {
      key,
      toolName: message.toolName ?? "unknown",
      toolCallId: message.toolCallId,
      exchangePositionFromEnd: 0,
      combinedTokens: 0,
      currentTokenEstimate,
      maxContextTokens,
      messages,
    };

    const entry = {
      message,
      messageIndex: i,
      positionFromEnd: messages.length - 1 - i,
      tokens: estimator.estimateMessage(message),
      content: message.content,
    };

    if (message.entryType === "tool-call") {
      existing.call = entry;
    } else {
      existing.result = entry;
    }

    existing.toolName = message.toolName ?? existing.toolName;
    existing.toolCallId = message.toolCallId ?? existing.toolCallId;
    existing.combinedTokens = (existing.call?.tokens ?? 0) + (existing.result?.tokens ?? 0);
    exchanges.set(key, existing);
  }

  const ordered = Array.from(exchanges.values()).sort((left, right) => {
    const leftTerminalIndex = Math.max(left.call?.messageIndex ?? -1, left.result?.messageIndex ?? -1);
    const rightTerminalIndex = Math.max(right.call?.messageIndex ?? -1, right.result?.messageIndex ?? -1);
    return leftTerminalIndex - rightTerminalIndex;
  });

  for (let i = ordered.length - 1, position = 0; i >= 0; i--, position++) {
    ordered[i].exchangePositionFromEnd = position;
  }

  return exchanges;
}

function truncateText(text: string, maxTokens: number, charsPerToken = 4): string {
  const maxChars = maxTokens * charsPerToken;
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[...truncated]`;
}

function defaultTruncateTokens(
  entryType: ToolEntryType,
  exchangePositionFromEnd: number,
  pressure: number
): number {
  if (entryType === "tool-call") {
    if (exchangePositionFromEnd === 0) return 128;
    if (exchangePositionFromEnd === 1) return 80;
    return pressure > 0.8 ? 48 : 72;
  }

  if (exchangePositionFromEnd === 0) return 160;
  if (exchangePositionFromEnd === 1) return 96;
  return pressure > 0.8 ? 72 : 96;
}

function createModificationType(entryType: ToolEntryType): CompressionModification["type"] {
  return entryType === "tool-call" ? "tool-call-truncated" : "tool-result-truncated";
}

function normalizeDecision(decision: ToolEntryPolicyDecision | undefined): ToolEntryPolicyDecision {
  return decision ?? { policy: "keep" };
}

function clonePlanEntry(entry: ToolCompressionPlanEntry): ToolCompressionPlanEntry {
  return {
    ...entry,
    decision: { ...entry.decision },
  };
}

async function resolveToolCompressionPlan(
  entries: ToolCompressionPlanEntry[],
  beforeToolCompression: BeforeToolCompression | undefined
): Promise<ToolCompressionPlanEntry[]> {
  if (!beforeToolCompression || entries.length === 0) {
    return entries;
  }

  const override = await beforeToolCompression(entries.map(clonePlanEntry));
  if (!override) {
    return entries;
  }

  if (override.length !== entries.length) {
    throw new Error("beforeToolCompression must return the same number of entries it received");
  }

  for (let i = 0; i < entries.length; i++) {
    const original = entries[i];
    const returned = override[i];

    if (
      returned.messageIndex !== original.messageIndex ||
      returned.message.id !== original.message.id ||
      returned.entryType !== original.entryType
    ) {
      throw new Error("beforeToolCompression must preserve entry ordering and identity");
    }
  }

  return override;
}

// Fraction of total context budget allocated per tool exchange at depth=1.
// Decays as 1/depth: at depth N, each exchange may use fraction/N of the context.
// This means large results are truncated aggressively while tiny results persist indefinitely.
const RESULT_BUDGET_FRACTION = 0.10;
const CALL_BUDGET_FRACTION = 0.06;

// Results exceeding this fraction of context are "heavy" (e.g. base64 images, large file reads).
// Heavy results are removed (not just truncated) once they leave depth=0.
const HEAVY_RESULT_FRACTION = 0.20;

// Minimum tokens worth keeping — below this we remove rather than produce a useless stub.
const MIN_KEEP_TOKENS = 32;

/**
 * Formula-based tool policy.
 *
 * Each exchange at depth D may retain at most `maxContext * fraction / D` tokens.
 * This naturally handles both dimensions the user cares about:
 *
 *   - Large results (e.g. 100k base64 screenshot): exceed the depth=1 budget immediately
 *     → truncated at depth=0, removed entirely at depth=1.
 *
 *   - Small results (e.g. 50-token directory listing): fit within budget even at depth=20+
 *     → stay in context indefinitely until the budget genuinely can't hold them.
 *
 * Depth=0 (the most recent exchange) is always preserved in full: the LLM hasn't
 * seen this result yet and needs it to continue reasoning.
 */
export function defaultToolPolicy(context: ToolPolicyContext) {
  const depth = context.exchangePositionFromEnd;

  // The most recent exchange is always preserved so the LLM sees what it just called.
  if (depth === 0) {
    return {};
  }

  const maxContext = context.maxContextTokens;
  if (maxContext <= 0) {
    return {};
  }

  const callTokens = context.call?.tokens ?? 0;
  const resultTokens = context.result?.tokens ?? 0;
  const decision: { call?: ToolEntryPolicyDecision; result?: ToolEntryPolicyDecision } = {};

  if (context.call) {
    const callAllowance = Math.max(MIN_KEEP_TOKENS, Math.floor(maxContext * CALL_BUDGET_FRACTION / depth));
    if (callTokens > callAllowance) {
      decision.call = { policy: "truncate", maxTokens: callAllowance };
    }
  }

  if (context.result) {
    const resultAllowance = Math.floor(maxContext * RESULT_BUDGET_FRACTION / depth);
    const isHeavy = resultTokens > maxContext * HEAVY_RESULT_FRACTION;
    if (resultTokens > resultAllowance) {
      // Heavy results (e.g. base64 screenshots) get truncated to the minimum stub so the
      // agent still knows it called the tool, but we don't waste tokens on stale output.
      const effectiveAllowance = (isHeavy || resultAllowance < MIN_KEEP_TOKENS)
        ? MIN_KEEP_TOKENS
        : resultAllowance;
      decision.result = { policy: "truncate", maxTokens: effectiveAllowance };
    }
  }

  return decision;
}

async function applyEntryPolicy(
  message: ContextMessage,
  toolName: string,
  exchangePositionFromEnd: number,
  decision: ToolEntryPolicyDecision,
  estimator: TokenEstimator,
  onToolContentTruncated: ((
    event: ToolContentTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>) | undefined
): Promise<{ message: ContextMessage; modification?: CompressionModification }> {
  if (decision.policy === "keep") {
    return { message };
  }

  const originalTokens = estimator.estimateMessage(message);
  const originalContent = message.content;
  const entryType = message.entryType as ToolEntryType;

  const event: ToolContentTruncationEvent = {
    entryType,
    toolName,
    toolCallId: message.toolCallId,
    messageId: message.id,
    messageIndex: -1,
    originalContent,
    originalTokens,
  };

  const overrideText = onToolContentTruncated ? await onToolContentTruncated(event) : undefined;
  const pressure = 1;
  const maxTokens = decision.maxTokens ?? defaultTruncateTokens(entryType, exchangePositionFromEnd, pressure);
  const content = typeof overrideText === "string" && overrideText.length > 0
    ? overrideText
    : truncateText(originalContent, maxTokens);

  if (content === originalContent) {
    return { message };
  }

  const nextMessage = {
    ...message,
    toolName,
    content,
  } satisfies ContextMessage;

  return {
    message: nextMessage,
    modification: {
      type: createModificationType(entryType),
      messageIndex: -1,
      originalTokens,
      compressedTokens: estimator.estimateMessage(nextMessage),
      toolName,
      toolCallId: message.toolCallId,
      originalText: originalContent,
    },
  };
}

export async function applyToolPolicy(
  messages: ContextMessage[],
  options: ToolPolicyOptions
): Promise<ToolPolicyResult> {
  const {
    estimator,
    currentTokenEstimate,
    maxContextTokens,
    toolPolicy,
    beforeToolCompression,
    onToolContentTruncated,
    onToolOutputTruncated,
  } = options;
  const modifications: CompressionModification[] = [];
  const result: ContextMessage[] = [];
  const exchanges = buildToolExchanges(messages, estimator, currentTokenEstimate, maxContextTokens);
  const decisions = new Map<string, Awaited<ReturnType<ToolPolicy>>>();
  const hook = onToolContentTruncated ?? onToolOutputTruncated;
  const plannedEntries: ToolCompressionPlanEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.entryType !== "tool-call" && message.entryType !== "tool-result") {
      continue;
    }

    const key = getExchangeKey(message);
    const exchange = exchanges.get(key);
    if (!exchange) {
      continue;
    }

    let decision = decisions.get(key);
    if (!decision) {
      decision = await (toolPolicy ?? defaultToolPolicy)(exchange);
      decisions.set(key, decision);
    }

    plannedEntries.push({
      message,
      messageIndex: i,
      entryType: message.entryType,
      toolName: exchange.toolName,
      toolCallId: message.toolCallId,
      exchangePositionFromEnd: exchange.exchangePositionFromEnd,
      combinedTokens: exchange.combinedTokens,
      call: exchange.call,
      result: exchange.result,
      decision: normalizeDecision(
        message.entryType === "tool-call" ? decision.call : decision.result
      ),
    });
  }

  const finalPlanEntries = await resolveToolCompressionPlan(plannedEntries, beforeToolCompression);
  let planIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.entryType !== "tool-call" && message.entryType !== "tool-result") {
      result.push(message);
      continue;
    }

    const planEntry = finalPlanEntries[planIndex];
    if (!planEntry || planEntry.messageIndex !== i || planEntry.message.id !== message.id) {
      result.push(message);
      continue;
    }
    planIndex += 1;

    const applied = await applyEntryPolicy(
      message,
      planEntry.toolName,
      planEntry.exchangePositionFromEnd,
      planEntry.decision,
      estimator,
      hook
        ? async (event) => hook({
            ...event,
            messageIndex: i,
          })
        : undefined
    );

    result.push(applied.message);
    if (applied.modification) {
      modifications.push({
        ...applied.modification,
        messageIndex: i,
      });
    }
  }

  return {
    messages: result,
    modifications,
    tokenEstimate: estimator.estimateMessages(result),
  };
}

export const applyToolOutputPolicy = applyToolPolicy;
