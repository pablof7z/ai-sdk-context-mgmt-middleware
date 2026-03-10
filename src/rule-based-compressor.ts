import type {
  CompressionModification,
  ContextMessage,
  TokenEstimator,
  ToolContentTruncationEvent,
  ToolEntryPolicyDecision,
  ToolEntryType,
  ToolOutputPolicy,
  ToolPolicy,
  ToolPolicyContext,
} from "./types.js";

interface ToolPolicyOptions {
  estimator: TokenEstimator;
  currentTokenEstimate: number;
  maxContextTokens: number;
  toolPolicy?: ToolPolicy;
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

function isWriteHeavyTool(toolName: string): boolean {
  return /(write|patch|edit|append|create|replace|insert|upsert|put)/i.test(toolName);
}

function isReadHeavyTool(toolName: string): boolean {
  return /(read|search|grep|glob|find|list|fetch|curl|get|download|query)/i.test(toolName);
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

function createPlaceholder(entryType: ToolEntryType): string {
  return entryType === "tool-call"
    ? "[Tool call input removed for brevity]"
    : "[Tool output removed for brevity]";
}

function createModificationType(entryType: ToolEntryType, policy: Exclude<ToolOutputPolicy, "keep">): CompressionModification["type"] {
  if (entryType === "tool-call") {
    return policy === "remove" ? "tool-call-removed" : "tool-call-truncated";
  }

  return policy === "remove" ? "tool-result-removed" : "tool-result-truncated";
}

function normalizeDecision(decision: ToolEntryPolicyDecision | undefined): ToolEntryPolicyDecision {
  return decision ?? { policy: "keep" };
}

export function defaultToolPolicy(context: ToolPolicyContext) {
  const pressure = context.maxContextTokens > 0
    ? context.currentTokenEstimate / context.maxContextTokens
    : 1;
  const exchangeDepth = context.exchangePositionFromEnd;
  const decision: { call?: ToolEntryPolicyDecision; result?: ToolEntryPolicyDecision } = {};

  const callTokens = context.call?.tokens ?? 0;
  const resultTokens = context.result?.tokens ?? 0;
  const combinedTokens = context.combinedTokens;

  if (context.call) {
    const callBudget = defaultTruncateTokens("tool-call", exchangeDepth, pressure);
    const shouldTruncateCall =
      callTokens > callBudget * 1.5 ||
      (isWriteHeavyTool(context.toolName) && callTokens > 120) ||
      (exchangeDepth >= 2 && callTokens > 90) ||
      combinedTokens > 650;

    if (shouldTruncateCall) {
      decision.call = {
        policy: "truncate",
        maxTokens: callBudget,
      };
    }
  }

  if (context.result) {
    const resultBudget = defaultTruncateTokens("tool-result", exchangeDepth, pressure);
    const shouldRemoveResult =
      (exchangeDepth >= 4 && resultTokens > 140) ||
      (exchangeDepth >= 3 && pressure > 0.9 && resultTokens > 100) ||
      (exchangeDepth >= 3 && combinedTokens > 900);
    const shouldTruncateResult =
      resultTokens > resultBudget * 1.5 ||
      (isReadHeavyTool(context.toolName) && resultTokens > 140) ||
      (exchangeDepth >= 1 && resultTokens > 120) ||
      combinedTokens > 650;

    if (shouldRemoveResult) {
      decision.result = { policy: "remove" };
    } else if (shouldTruncateResult) {
      decision.result = {
        policy: "truncate",
        maxTokens: resultBudget,
      };
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
  const removed = decision.policy === "remove";

  const event: ToolContentTruncationEvent = {
    entryType,
    toolName,
    toolCallId: message.toolCallId,
    messageIndex: -1,
    originalContent,
    originalTokens,
    removed,
  };

  const overrideText = onToolContentTruncated ? await onToolContentTruncated(event) : undefined;
  const pressure = 1;
  const maxTokens = decision.maxTokens ?? defaultTruncateTokens(entryType, exchangePositionFromEnd, pressure);
  const content = removed
    ? (typeof overrideText === "string" && overrideText.length > 0 ? overrideText : createPlaceholder(entryType))
    : (typeof overrideText === "string" && overrideText.length > 0 ? overrideText : truncateText(originalContent, maxTokens));

  if (!removed && content === originalContent) {
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
      type: createModificationType(entryType, decision.policy),
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
    onToolContentTruncated,
    onToolOutputTruncated,
  } = options;
  const modifications: CompressionModification[] = [];
  const result: ContextMessage[] = [];
  const exchanges = buildToolExchanges(messages, estimator, currentTokenEstimate, maxContextTokens);
  const decisions = new Map<string, Awaited<ReturnType<ToolPolicy>>>();
  const hook = onToolContentTruncated ?? onToolOutputTruncated;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.entryType !== "tool-call" && message.entryType !== "tool-result") {
      result.push(message);
      continue;
    }

    const key = getExchangeKey(message);
    const exchange = exchanges.get(key);
    if (!exchange) {
      result.push(message);
      continue;
    }

    let decision = decisions.get(key);
    if (!decision) {
      decision = await (toolPolicy ?? defaultToolPolicy)(exchange);
      decisions.set(key, decision);
    }

    const entryDecision = normalizeDecision(
      message.entryType === "tool-call" ? decision.call : decision.result
    );
    const applied = await applyEntryPolicy(
      message,
      exchange.toolName,
      exchange.exchangePositionFromEnd,
      entryDecision,
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
