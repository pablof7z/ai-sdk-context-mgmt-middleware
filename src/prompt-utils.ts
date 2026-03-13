import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
import type {
  ContextManagementRequestContext,
  PromptTokenEstimator,
  RemovedToolExchange,
} from "./types.js";

interface ToolExchange {
  toolCallId: string;
  toolName: string;
  callMessageIndex?: number;
  resultMessageIndices: number[];
}

function cloneUnknown<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return value;
}

function cloneMessage(message: LanguageModelV3Message): LanguageModelV3Message {
  if (message.role === "system") {
    return {
      ...message,
      providerOptions: cloneUnknown(message.providerOptions),
    };
  }

  if (message.role === "user") {
    return {
      ...message,
      providerOptions: cloneUnknown(message.providerOptions),
      content: message.content.map((part) => ({
        ...part,
        providerOptions: cloneUnknown(part.providerOptions),
      })),
    };
  }

  if (message.role === "assistant") {
    return {
      ...message,
      providerOptions: cloneUnknown(message.providerOptions),
      content: message.content.map((part) => {
        switch (part.type) {
          case "tool-call":
            return {
              ...part,
              input: cloneUnknown(part.input),
              providerOptions: cloneUnknown(part.providerOptions),
            };
          case "tool-result":
            return {
              ...part,
              output: cloneUnknown(part.output),
              providerOptions: cloneUnknown(part.providerOptions),
            };
          default:
            return {
              ...part,
              providerOptions: cloneUnknown(part.providerOptions),
            };
        }
      }),
    };
  }

  return {
    ...message,
    providerOptions: cloneUnknown(message.providerOptions),
    content: message.content.map((part) => {
      if (part.type === "tool-result") {
        return {
          ...part,
          output: cloneUnknown(part.output),
          providerOptions: cloneUnknown(part.providerOptions),
        };
      }

      return {
        ...part,
        providerOptions: cloneUnknown(part.providerOptions),
      };
    }),
  };
}

function isToolCallPart(part: unknown): part is LanguageModelV3ToolCallPart {
  return typeof part === "object" && part !== null && (part as { type?: string }).type === "tool-call";
}

function isToolResultPart(part: unknown): part is LanguageModelV3ToolResultPart {
  return typeof part === "object" && part !== null && (part as { type?: string }).type === "tool-result";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildRemovedToolExchanges(
  originalPrompt: LanguageModelV3Prompt,
  nextPrompt: LanguageModelV3Prompt,
  reason: string
): RemovedToolExchange[] {
  const original = collectToolExchanges(originalPrompt);
  const next = collectToolExchanges(nextPrompt);
  const removed: RemovedToolExchange[] = [];

  for (const exchange of original.values()) {
    if (next.has(exchange.toolCallId)) {
      continue;
    }

    removed.push({
      toolCallId: exchange.toolCallId,
      toolName: exchange.toolName,
      reason,
    });
  }

  return removed;
}

function computeTailStartIndex(prompt: LanguageModelV3Prompt, keepLastMessages: number): number {
  const nonSystemIndices = prompt.flatMap((message, index) => message.role === "system" ? [] : [index]);

  if (nonSystemIndices.length === 0) {
    return prompt.length;
  }

  if (keepLastMessages <= 0) {
    return prompt.length;
  }

  if (keepLastMessages >= nonSystemIndices.length) {
    return 0;
  }

  let startIndex = nonSystemIndices[nonSystemIndices.length - keepLastMessages];
  const exchanges = collectToolExchanges(prompt);

  for (;;) {
    let nextStartIndex = startIndex;

    for (const exchange of exchanges.values()) {
      const hasKeptResult = exchange.resultMessageIndices.some((messageIndex) => messageIndex >= startIndex);

      if (!hasKeptResult || exchange.callMessageIndex === undefined) {
        continue;
      }

      if (exchange.callMessageIndex < nextStartIndex) {
        nextStartIndex = exchange.callMessageIndex;
      }
    }

    if (nextStartIndex === startIndex) {
      return startIndex;
    }

    startIndex = nextStartIndex;
  }
}

function buildPromptFromTail(prompt: LanguageModelV3Prompt, startIndex: number): LanguageModelV3Prompt {
  const cloned = clonePrompt(prompt);
  return cloned.filter((message, index) => message.role === "system" || index >= startIndex);
}

export function clonePrompt(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  return prompt.map((message) => cloneMessage(message));
}

export function extractRequestContext(
  params: Pick<LanguageModelV3CallOptions, "providerOptions">
): ContextManagementRequestContext | null {
  const rawContext = params.providerOptions?.[CONTEXT_MANAGEMENT_KEY];

  if (!isRecord(rawContext)) {
    return null;
  }

  const conversationId = rawContext.conversationId;
  const agentId = rawContext.agentId;

  if (typeof conversationId !== "string" || conversationId.length === 0) {
    return null;
  }

  if (typeof agentId !== "string" || agentId.length === 0) {
    return null;
  }

  return {
    conversationId,
    agentId,
    ...(typeof rawContext.agentLabel === "string" && rawContext.agentLabel.length > 0
      ? { agentLabel: rawContext.agentLabel }
      : {}),
  };
}

export function collectToolExchanges(prompt: LanguageModelV3Prompt): Map<string, ToolExchange> {
  const exchanges = new Map<string, ToolExchange>();

  for (const [messageIndex, message] of prompt.entries()) {
    if (message.role === "system") {
      continue;
    }

    for (const part of message.content) {
      if (isToolCallPart(part)) {
        const existing = exchanges.get(part.toolCallId) ?? {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          resultMessageIndices: [],
        };
        existing.toolName = part.toolName;
        existing.callMessageIndex = existing.callMessageIndex ?? messageIndex;
        exchanges.set(part.toolCallId, existing);
        continue;
      }

      if (isToolResultPart(part)) {
        const existing = exchanges.get(part.toolCallId) ?? {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          resultMessageIndices: [],
        };
        existing.toolName = part.toolName;
        existing.resultMessageIndices.push(messageIndex);
        exchanges.set(part.toolCallId, existing);
      }
    }
  }

  return exchanges;
}

export function removeToolExchanges(
  prompt: LanguageModelV3Prompt,
  toolCallIds: readonly string[],
  reason: string
): { prompt: LanguageModelV3Prompt; removedToolExchanges: RemovedToolExchange[] } {
  if (toolCallIds.length === 0) {
    return {
      prompt: clonePrompt(prompt),
      removedToolExchanges: [],
    };
  }

  const idsToRemove = new Set(toolCallIds);
  const cloned = clonePrompt(prompt);
  const nextPrompt: LanguageModelV3Prompt = [];

  for (const message of cloned) {
    if (message.role === "system") {
      nextPrompt.push(message);
      continue;
    }

    if (message.role === "user") {
      nextPrompt.push(message);
      continue;
    }

    const filteredContent = message.content.filter((part) => {
      if (isToolCallPart(part) || isToolResultPart(part)) {
        return !idsToRemove.has(part.toolCallId);
      }

      return true;
    });

    if (filteredContent.length === 0) {
      continue;
    }

    if (message.role === "assistant") {
      nextPrompt.push({
        ...message,
        content: filteredContent as typeof message.content,
      });
      continue;
    }

    nextPrompt.push({
      ...message,
      content: filteredContent as typeof message.content,
    });
  }

  return {
    prompt: nextPrompt,
    removedToolExchanges: buildRemovedToolExchanges(prompt, nextPrompt, reason),
  };
}

export function trimPromptToLastMessages(
  prompt: LanguageModelV3Prompt,
  keepLastMessages: number,
  reason: string,
  options?: {
    estimator?: PromptTokenEstimator;
    maxPromptTokens?: number;
  }
): { prompt: LanguageModelV3Prompt; removedToolExchanges: RemovedToolExchange[] } {
  const normalizedKeepLastMessages = Math.max(0, Math.floor(keepLastMessages));
  const nonSystemMessageCount = prompt.reduce((count, message) => count + (message.role === "system" ? 0 : 1), 0);
  const estimator = options?.estimator ?? createDefaultPromptTokenEstimator();
  const maxPromptTokens = options?.maxPromptTokens;

  if (
    normalizedKeepLastMessages >= nonSystemMessageCount &&
    (maxPromptTokens === undefined || estimator.estimatePrompt(prompt) <= maxPromptTokens)
  ) {
    return {
      prompt: clonePrompt(prompt),
      removedToolExchanges: [],
    };
  }

  let bestResult = {
    prompt: clonePrompt(prompt),
    removedToolExchanges: [] as RemovedToolExchange[],
  };

  for (let keep = Math.min(normalizedKeepLastMessages, nonSystemMessageCount); keep >= 0; keep--) {
    const startIndex = computeTailStartIndex(prompt, keep);
    const nextPrompt = buildPromptFromTail(prompt, startIndex);
    const result = {
      prompt: nextPrompt,
      removedToolExchanges: buildRemovedToolExchanges(prompt, nextPrompt, reason),
    };

    bestResult = result;

    if (maxPromptTokens === undefined || estimator.estimatePrompt(nextPrompt) <= maxPromptTokens) {
      return result;
    }
  }

  return bestResult;
}

export function appendReminderToLatestUserMessage(
  prompt: LanguageModelV3Prompt,
  reminderText: string
): LanguageModelV3Prompt {
  const cloned = clonePrompt(prompt);

  for (let index = cloned.length - 1; index >= 0; index--) {
    const message = cloned[index];
    if (message.role !== "user") {
      continue;
    }

    cloned[index] = {
      ...message,
      content: [
        ...message.content,
        { type: "text", text: reminderText },
      ],
    };
    return cloned;
  }

  return [
    ...cloned,
    {
      role: "user",
      content: [{ type: "text", text: reminderText }],
    },
  ];
}
