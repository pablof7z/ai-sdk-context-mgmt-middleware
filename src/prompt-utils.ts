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
  ScratchpadUseNotice,
} from "./types.js";

export interface ToolExchange {
  toolCallId: string;
  toolName: string;
  callMessageIndex?: number;
  resultMessageIndices: number[];
}

type PromptLikeMessage = {
  role: string;
  content: unknown;
};

type ScratchpadSemanticTurn = {
  user: Extract<LanguageModelV3Message, { role: "user" }>;
  assistant?: Extract<LanguageModelV3Message, { role: "assistant" }>;
};

type ScratchpadTurnSpan = {
  startIndex: number;
  endIndex: number;
  hasAssistantText: boolean;
};

function cloneUnknown<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }

  return value;
}

function buildReminderSystemMessage(reminderText: string): LanguageModelV3Message {
  return {
    role: "system",
    content: reminderText,
    providerOptions: { contextManagement: { type: "reminder" } },
  };
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

function isTextPart(part: unknown): part is { type: "text"; text: string; providerOptions?: unknown } {
  return isRecord(part) && part.type === "text" && typeof part.text === "string";
}

function getTextParts(content: unknown): Array<{ type: "text"; text: string; providerOptions?: unknown }> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter(isTextPart)
    .map((part) => ({
      type: "text" as const,
      text: part.text,
      providerOptions: cloneUnknown(part.providerOptions),
    }));
}

function hasTextContent(message: PromptLikeMessage): boolean {
  return getTextParts(message.content).length > 0;
}

function isScratchpadUseNoticeText(text: string): boolean {
  return text.startsWith("<system-reminder>[scratchpad used: ")
    && text.endsWith("]</system-reminder>");
}

function isScratchpadUseNoticeMessage(message: PromptLikeMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }

  if (Array.isArray(message.content) && message.content.some((part) => !isTextPart(part))) {
    return false;
  }

  const textParts = getTextParts(message.content);
  return textParts.length === 1 && isScratchpadUseNoticeText(textParts[0].text);
}

function cloneAssistantTextMessage(
  message: Extract<LanguageModelV3Message, { role: "assistant" }>
): Extract<LanguageModelV3Message, { role: "assistant" }> | undefined {
  const cloned = cloneMessage(message);
  if (cloned.role !== "assistant") {
    return undefined;
  }

  const textParts = cloned.content.filter((part) => part.type === "text");
  if (textParts.length === 0) {
    return undefined;
  }

  return {
    ...cloned,
    content: textParts,
  };
}

function extractScratchpadSemanticTurns(prompt: LanguageModelV3Prompt): ScratchpadSemanticTurn[] {
  const turns: ScratchpadSemanticTurn[] = [];
  let openTurn: ScratchpadSemanticTurn | undefined;

  for (const message of prompt) {
    if (message.role === "system" || isScratchpadUseNoticeMessage(message)) {
      continue;
    }

    if (message.role === "user") {
      if (openTurn) {
        turns.push(openTurn);
      }
      openTurn = {
        user: cloneMessage(message) as Extract<LanguageModelV3Message, { role: "user" }>,
      };
      continue;
    }

    if (message.role === "assistant" && openTurn) {
      const assistant = cloneAssistantTextMessage(message);
      if (assistant) {
        openTurn.assistant = assistant;
        turns.push(openTurn);
        openTurn = undefined;
      }
    }
  }

  if (openTurn) {
    turns.push(openTurn);
  }

  return turns;
}

function flattenScratchpadTurns(turns: readonly ScratchpadSemanticTurn[]): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];

  for (const turn of turns) {
    prompt.push(turn.user);
    if (turn.assistant) {
      prompt.push(turn.assistant);
    }
  }

  return prompt;
}

function extractScratchpadTurnSpans(prompt: LanguageModelV3Prompt): ScratchpadTurnSpan[] {
  const spans: ScratchpadTurnSpan[] = [];
  let openSpan: ScratchpadTurnSpan | undefined;

  for (const [index, message] of prompt.entries()) {
    if (message.role === "system" || isScratchpadUseNoticeMessage(message)) {
      continue;
    }

    if (message.role === "user") {
      if (openSpan) {
        spans.push({
          ...openSpan,
          endIndex: index,
        });
      }

      openSpan = {
        startIndex: index,
        endIndex: prompt.length,
        hasAssistantText: false,
      };
      continue;
    }

    if (!openSpan) {
      continue;
    }

    if (message.role === "assistant" && hasTextContent(message)) {
      openSpan = {
        ...openSpan,
        hasAssistantText: true,
      };
    }
  }

  if (openSpan) {
    spans.push(openSpan);
  }

  return spans;
}

function flattenScratchpadTurnSpans(
  prompt: LanguageModelV3Prompt,
  spans: readonly ScratchpadTurnSpan[]
): LanguageModelV3Prompt {
  return spans.flatMap((span) =>
    clonePrompt(prompt.slice(span.startIndex, span.endIndex))
  );
}

function getUnmatchedTurnTail(
  turns: readonly ScratchpadSemanticTurn[]
): ScratchpadSemanticTurn[] {
  const latestTurn = turns.at(-1);
  return latestTurn && latestTurn.assistant === undefined ? [latestTurn] : [];
}

function getUnmatchedTurnSpanTail(
  spans: readonly ScratchpadTurnSpan[]
): ScratchpadTurnSpan[] {
  const latestSpan = spans.at(-1);
  return latestSpan && !latestSpan.hasAssistantText ? [latestSpan] : [];
}

function removeScratchpadUseNotices(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  return clonePrompt(prompt).filter((message) => !isScratchpadUseNoticeMessage(message));
}

function compactScratchpadTurns(
  prompt: LanguageModelV3Prompt,
  preserveTurns?: number | null
): LanguageModelV3Prompt {
  const systemMessages = prompt
    .filter((message) => message.role === "system")
    .map((message) => cloneMessage(message));
  const turnSpans = extractScratchpadTurnSpans(prompt);
  const normalizedPreserveTurns = typeof preserveTurns === "number" && Number.isFinite(preserveTurns)
    ? Math.max(0, Math.floor(preserveTurns))
    : undefined;

  if (normalizedPreserveTurns === undefined) {
    return clonePrompt(prompt);
  }

  let preservedHeadTurnSpans = turnSpans;
  let preservedTailTurnSpans: ScratchpadTurnSpan[] = [];

  if (normalizedPreserveTurns === 0) {
    preservedHeadTurnSpans = [];
    preservedTailTurnSpans = getUnmatchedTurnSpanTail(turnSpans);
  } else if (turnSpans.length > normalizedPreserveTurns * 2) {
    preservedHeadTurnSpans = turnSpans.slice(0, normalizedPreserveTurns);
    preservedTailTurnSpans = turnSpans.slice(turnSpans.length - normalizedPreserveTurns);
  }

  return [
    ...systemMessages,
    ...flattenScratchpadTurnSpans(prompt, preservedHeadTurnSpans),
    ...flattenScratchpadTurnSpans(prompt, preservedTailTurnSpans),
  ];
}

export function buildScratchpadUseNoticeText(description: string): string {
  return `<system-reminder>[scratchpad used: ${description}]</system-reminder>`;
}

export function buildScratchpadUseNoticeMessage(description: string): LanguageModelV3Message {
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: buildScratchpadUseNoticeText(description),
      },
    ],
  };
}

function inspectScratchpadSemanticTurns(messages: readonly PromptLikeMessage[]): {
  turnCount: number;
  latestTurnHasAssistant: boolean;
} {
  let openTurnCount = 0;
  let turnCount = 0;
  let latestTurnHasAssistant = false;

  for (const message of messages) {
    if (message.role === "system" || isScratchpadUseNoticeMessage(message)) {
      continue;
    }

    if (message.role === "user") {
      turnCount += 1;
      openTurnCount = 1;
      latestTurnHasAssistant = false;
      continue;
    }

    if (message.role === "assistant" && openTurnCount > 0 && hasTextContent(message)) {
      openTurnCount = 0;
      latestTurnHasAssistant = true;
    }
  }

  return {
    turnCount,
    latestTurnHasAssistant,
  };
}

export function countScratchpadSemanticTurns(messages: readonly PromptLikeMessage[]): number {
  return inspectScratchpadSemanticTurns(messages).turnCount;
}

export function countProjectedScratchpadTurns(
  messages: readonly PromptLikeMessage[],
  preserveTurns?: number | null
): number {
  const { turnCount, latestTurnHasAssistant } = inspectScratchpadSemanticTurns(messages);
  const normalizedPreserveTurns = typeof preserveTurns === "number" && Number.isFinite(preserveTurns)
    ? Math.max(0, Math.floor(preserveTurns))
    : undefined;

  if (normalizedPreserveTurns === undefined) {
    return turnCount;
  }

  if (normalizedPreserveTurns === 0) {
    return turnCount > 0 && !latestTurnHasAssistant ? 1 : 0;
  }

  return turnCount <= normalizedPreserveTurns * 2
    ? turnCount
    : normalizedPreserveTurns * 2;
}

function replaceScratchpadExchangesWithNotices(
  prompt: LanguageModelV3Prompt,
  activeToolCallId: string
): LanguageModelV3Prompt {
  const exchanges = collectToolExchanges(prompt);

  const scratchpadNotices = new Map<string, string>();
  for (const exchange of exchanges.values()) {
    if (exchange.toolName !== "scratchpad" || exchange.toolCallId === activeToolCallId) {
      continue;
    }

    let description = "scratchpad update";
    if (exchange.callMessageIndex !== undefined) {
      const callMessage = prompt[exchange.callMessageIndex];
      if (callMessage.role !== "system") {
        for (const part of callMessage.content) {
          if (
            isToolCallPart(part) &&
            part.toolCallId === exchange.toolCallId &&
            isRecord(part.input) &&
            typeof (part.input as Record<string, unknown>).description === "string"
          ) {
            description = (part.input as Record<string, unknown>).description as string;
            break;
          }
        }
      }
    }

    scratchpadNotices.set(exchange.toolCallId, description);
  }

  if (scratchpadNotices.size === 0) {
    return prompt;
  }

  const emittedNotices = new Set<string>();
  const result: LanguageModelV3Prompt = [];

  for (const message of prompt) {
    if (message.role === "system" || message.role === "user") {
      result.push(message);
      continue;
    }

    const scratchpadCallIds: string[] = [];
    const filteredContent = message.content.filter((part) => {
      if (isToolCallPart(part) && scratchpadNotices.has(part.toolCallId)) {
        scratchpadCallIds.push(part.toolCallId);
        return false;
      }
      if (isToolResultPart(part) && scratchpadNotices.has(part.toolCallId)) {
        return false;
      }
      return true;
    });

    if (filteredContent.length > 0) {
      if (filteredContent.length === message.content.length) {
        result.push(message);
      } else if (message.role === "assistant") {
        result.push({
          ...message,
          content: filteredContent as typeof message.content,
        });
      } else {
        result.push({
          ...message,
          content: filteredContent as typeof message.content,
        });
      }
    }

    for (const toolCallId of scratchpadCallIds) {
      if (!emittedNotices.has(toolCallId)) {
        result.push(buildScratchpadUseNoticeMessage(scratchpadNotices.get(toolCallId)!));
        emittedNotices.add(toolCallId);
      }
    }
  }

  return result;
}

export function projectScratchpadPrompt(
  prompt: LanguageModelV3Prompt,
  options: {
    preserveTurns?: number | null;
    notice?: ScratchpadUseNotice;
  }
): LanguageModelV3Prompt {
  if (!options.notice) {
    return clonePrompt(prompt);
  }

  const promptWithoutNotices = replaceScratchpadExchangesWithNotices(
    removeScratchpadUseNotices(prompt),
    options.notice.toolCallId
  );
  const noticeMessage = buildScratchpadUseNoticeMessage(options.notice.description);
  const exchanges = collectToolExchanges(promptWithoutNotices);
  const noticeExchange = exchanges.get(options.notice.toolCallId);

  if (noticeExchange?.callMessageIndex !== undefined) {
    const exchangeMessageIndices = [
      noticeExchange.callMessageIndex,
      ...noticeExchange.resultMessageIndices,
    ];
    const afterNoticeIndex = exchangeMessageIndices.length > 0
      ? Math.max(...exchangeMessageIndices) + 1
      : noticeExchange.callMessageIndex + 1;
    const preNoticePrompt = promptWithoutNotices.slice(0, noticeExchange.callMessageIndex);
    const postNoticePrompt = promptWithoutNotices.slice(afterNoticeIndex);

    return [
      ...compactScratchpadTurns(preNoticePrompt, options.preserveTurns),
      noticeMessage,
      ...clonePrompt(postNoticePrompt),
    ];
  }

  const systemMessages = promptWithoutNotices
    .filter((message) => message.role === "system")
    .map((message) => cloneMessage(message));
  const turnSpans = extractScratchpadTurnSpans(promptWithoutNotices);
  const preTurnCount = Math.min(
    Math.max(0, Math.floor(options.notice.rawTurnCountAtCall)),
    turnSpans.length
  );
  const preTurnSpans = turnSpans.slice(0, preTurnCount);
  const futureTurnSpans = turnSpans.slice(preTurnCount);
  const normalizedPreserveTurns = typeof options.preserveTurns === "number" && Number.isFinite(options.preserveTurns)
    ? Math.max(0, Math.floor(options.preserveTurns))
    : undefined;

  if (normalizedPreserveTurns === undefined) {
    return [
      ...systemMessages,
      ...flattenScratchpadTurnSpans(promptWithoutNotices, preTurnSpans),
      noticeMessage,
      ...flattenScratchpadTurnSpans(promptWithoutNotices, futureTurnSpans),
    ];
  }

  let preservedHeadTurnSpans = preTurnSpans;
  let preservedTailTurnSpans: ScratchpadTurnSpan[] = [];

  if (normalizedPreserveTurns === 0) {
    preservedHeadTurnSpans = [];
    preservedTailTurnSpans = getUnmatchedTurnSpanTail(preTurnSpans);
  } else if (preTurnSpans.length > normalizedPreserveTurns * 2) {
    preservedHeadTurnSpans = preTurnSpans.slice(0, normalizedPreserveTurns);
    preservedTailTurnSpans = preTurnSpans.slice(preTurnSpans.length - normalizedPreserveTurns);
  }

  return [
    ...systemMessages,
    ...flattenScratchpadTurnSpans(promptWithoutNotices, preservedHeadTurnSpans),
    noticeMessage,
    ...flattenScratchpadTurnSpans(promptWithoutNotices, preservedTailTurnSpans),
    ...flattenScratchpadTurnSpans(promptWithoutNotices, futureTurnSpans),
  ];
}

export function isContextManagementSystemMessage(message: LanguageModelV3Message): boolean {
  if (message.role !== "system") {
    return false;
  }

  return isRecord(message.providerOptions?.contextManagement);
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

export function getPinnedMessageIndices(
  prompt: LanguageModelV3Prompt,
  pinnedToolCallIds: ReadonlySet<string>
): Set<number> {
  if (pinnedToolCallIds.size === 0) {
    return new Set<number>();
  }

  const exchanges = collectToolExchanges(prompt);
  const pinnedMessageIndices = new Set<number>();

  for (const toolCallId of pinnedToolCallIds) {
    const exchange = exchanges.get(toolCallId);

    if (!exchange) {
      continue;
    }

    if (exchange.callMessageIndex !== undefined) {
      pinnedMessageIndices.add(exchange.callMessageIndex);
    }

    for (const index of exchange.resultMessageIndices) {
      pinnedMessageIndices.add(index);
    }
  }

  return pinnedMessageIndices;
}

export function buildPromptFromSelectedIndices(
  prompt: LanguageModelV3Prompt,
  selectedIndices: ReadonlySet<number>
): LanguageModelV3Prompt {
  const cloned = clonePrompt(prompt);
  return cloned.filter((message, index) => message.role === "system" || selectedIndices.has(index));
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

export function getLatestToolActivity(prompt: LanguageModelV3Prompt): {
  toolCallId: string;
  toolName: string;
  type: "tool-call" | "tool-result";
} | null {
  for (let messageIndex = prompt.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = prompt[messageIndex];

    if (message.role === "system") {
      continue;
    }

    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex];

      if (isToolResultPart(part)) {
        return {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          type: "tool-result",
        };
      }

      if (isToolCallPart(part)) {
        return {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          type: "tool-call",
        };
      }
    }
  }

  return null;
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
    headCount?: number;
    estimator?: PromptTokenEstimator;
    maxPromptTokens?: number;
    pinnedToolCallIds?: ReadonlySet<string>;
  }
): { prompt: LanguageModelV3Prompt; removedToolExchanges: RemovedToolExchange[] } {
  const normalizedHeadCount = Math.max(0, Math.floor(options?.headCount ?? 0));
  const normalizedKeepLastMessages = Math.max(0, Math.floor(keepLastMessages));
  const nonSystemMessageCount = prompt.reduce((count, message) => count + (message.role === "system" ? 0 : 1), 0);
  const estimator = options?.estimator ?? createDefaultPromptTokenEstimator();
  const maxPromptTokens = options?.maxPromptTokens;

  if (
    normalizedHeadCount + normalizedKeepLastMessages >= nonSystemMessageCount &&
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
    const result = trimPromptHeadAndTail(
      prompt,
      normalizedHeadCount,
      keep,
      reason,
      { pinnedToolCallIds: options?.pinnedToolCallIds }
    );

    bestResult = result;

    if (maxPromptTokens === undefined || estimator.estimatePrompt(result.prompt) <= maxPromptTokens) {
      return result;
    }
  }

  return bestResult;
}

export function trimPromptHeadAndTail(
  prompt: LanguageModelV3Prompt,
  headCount: number,
  tailCount: number,
  reason: string,
  options?: {
    pinnedToolCallIds?: ReadonlySet<string>;
  }
): { prompt: LanguageModelV3Prompt; removedToolExchanges: RemovedToolExchange[] } {
  const normalizedHead = Math.max(0, Math.floor(headCount));
  const normalizedTail = Math.max(0, Math.floor(tailCount));

  const nonSystemIndices: number[] = [];
  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i].role !== "system") {
      nonSystemIndices.push(i);
    }
  }

  if (nonSystemIndices.length <= normalizedHead + normalizedTail) {
    return {
      prompt: clonePrompt(prompt),
      removedToolExchanges: [],
    };
  }

  const exchanges = collectToolExchanges(prompt);

  // Determine head boundary: first headCount non-system messages (exclusive index into nonSystemIndices)
  let headEndNonSystem = normalizedHead;

  // Expand head boundary forward to avoid splitting tool exchanges
  for (;;) {
    let expanded = false;
    for (const exchange of exchanges.values()) {
      if (exchange.callMessageIndex === undefined) continue;

      const callNsIdx = nonSystemIndices.indexOf(exchange.callMessageIndex);
      const resultNsIndices = exchange.resultMessageIndices
        .map((ri) => nonSystemIndices.indexOf(ri))
        .filter((i) => i !== -1);

      if (callNsIdx !== -1 && callNsIdx < headEndNonSystem) {
        for (const rni of resultNsIndices) {
          if (rni >= headEndNonSystem && rni < nonSystemIndices.length - normalizedTail) {
            headEndNonSystem = rni + 1;
            expanded = true;
          }
        }
      }

      for (const rni of resultNsIndices) {
        if (rni < headEndNonSystem && callNsIdx >= headEndNonSystem && callNsIdx < nonSystemIndices.length - normalizedTail) {
          headEndNonSystem = callNsIdx + 1;
          expanded = true;
        }
      }
    }
    if (!expanded) break;
  }

  // Determine tail boundary: last tailCount non-system messages (inclusive index into nonSystemIndices)
  let tailStartNonSystem = nonSystemIndices.length - normalizedTail;

  // Expand tail boundary backward to avoid splitting tool exchanges
  for (;;) {
    let expanded = false;
    for (const exchange of exchanges.values()) {
      if (exchange.callMessageIndex === undefined) continue;

      const callNsIdx = nonSystemIndices.indexOf(exchange.callMessageIndex);
      const resultNsIndices = exchange.resultMessageIndices
        .map((ri) => nonSystemIndices.indexOf(ri))
        .filter((i) => i !== -1);

      for (const rni of resultNsIndices) {
        if (rni >= tailStartNonSystem && callNsIdx !== -1 && callNsIdx < tailStartNonSystem && callNsIdx >= headEndNonSystem) {
          tailStartNonSystem = callNsIdx;
          expanded = true;
        }
      }

      if (callNsIdx !== -1 && callNsIdx >= tailStartNonSystem) {
        for (const rni of resultNsIndices) {
          if (rni < tailStartNonSystem && rni >= headEndNonSystem) {
            tailStartNonSystem = rni;
            expanded = true;
          }
        }
      }
    }
    if (!expanded) break;
  }

  // If boundaries overlap or meet, nothing to drop
  if (headEndNonSystem >= tailStartNonSystem) {
    return {
      prompt: clonePrompt(prompt),
      removedToolExchanges: [],
    };
  }

  const keptIndices = getPinnedMessageIndices(prompt, options?.pinnedToolCallIds ?? new Set<string>());

  for (let i = 0; i < headEndNonSystem; i++) {
    keptIndices.add(nonSystemIndices[i]);
  }

  for (let i = tailStartNonSystem; i < nonSystemIndices.length; i++) {
    keptIndices.add(nonSystemIndices[i]);
  }

  const nextPrompt = buildPromptFromSelectedIndices(prompt, keptIndices);

  // Build removed tool exchanges
  const nextExchanges = collectToolExchanges(nextPrompt);
  const removedToolExchanges: RemovedToolExchange[] = [];
  for (const exchange of exchanges.values()) {
    if (!nextExchanges.has(exchange.toolCallId)) {
      removedToolExchanges.push({
        toolCallId: exchange.toolCallId,
        toolName: exchange.toolName,
        reason,
      });
    }
  }

  return {
    prompt: nextPrompt,
    removedToolExchanges,
  };
}

export function trimPromptHeadAndTailAroundAnchor(
  prompt: LanguageModelV3Prompt,
  headCount: number,
  tailCount: number,
  anchorToolCallId: string,
  reason: string,
  options?: {
    pinnedToolCallIds?: ReadonlySet<string>;
  }
): { prompt: LanguageModelV3Prompt; removedToolExchanges: RemovedToolExchange[] } {
  const normalizedHead = Math.max(0, Math.floor(headCount));
  const normalizedTail = Math.max(0, Math.floor(tailCount));
  const exchanges = collectToolExchanges(prompt);
  const anchorExchange = exchanges.get(anchorToolCallId);
  const anchorStartIndex = anchorExchange?.callMessageIndex
    ?? anchorExchange?.resultMessageIndices.reduce(
      (min, index) => Math.min(min, index),
      Number.POSITIVE_INFINITY
    );

  if (anchorStartIndex === undefined || !Number.isFinite(anchorStartIndex)) {
    return {
      prompt: clonePrompt(prompt),
      removedToolExchanges: [],
    };
  }

  const preAnchorNonSystemIndices: number[] = [];
  for (let index = 0; index < anchorStartIndex; index += 1) {
    if (prompt[index].role !== "system") {
      preAnchorNonSystemIndices.push(index);
    }
  }

  if (preAnchorNonSystemIndices.length <= normalizedHead + normalizedTail) {
    return {
      prompt: clonePrompt(prompt),
      removedToolExchanges: [],
    };
  }

  const keptIndices = getPinnedMessageIndices(prompt, options?.pinnedToolCallIds ?? new Set<string>());
  const headLimit = Math.min(normalizedHead, preAnchorNonSystemIndices.length);
  const tailStart = Math.max(headLimit, preAnchorNonSystemIndices.length - normalizedTail);

  for (let index = 0; index < headLimit; index += 1) {
    keptIndices.add(preAnchorNonSystemIndices[index]);
  }

  for (let index = tailStart; index < preAnchorNonSystemIndices.length; index += 1) {
    keptIndices.add(preAnchorNonSystemIndices[index]);
  }

  for (let index = anchorStartIndex; index < prompt.length; index += 1) {
    if (prompt[index].role !== "system") {
      keptIndices.add(index);
    }
  }

  for (;;) {
    let expanded = false;

    for (const exchange of exchanges.values()) {
      const exchangeIndices = [
        ...(exchange.callMessageIndex !== undefined ? [exchange.callMessageIndex] : []),
        ...exchange.resultMessageIndices,
      ];

      if (exchangeIndices.length === 0) {
        continue;
      }

      const shouldKeepWholeExchange = exchangeIndices.some((index) => keptIndices.has(index));
      if (!shouldKeepWholeExchange) {
        continue;
      }

      for (const index of exchangeIndices) {
        if (!keptIndices.has(index)) {
          keptIndices.add(index);
          expanded = true;
        }
      }
    }

    if (!expanded) {
      break;
    }
  }

  const nextPrompt = buildPromptFromSelectedIndices(prompt, keptIndices);
  return {
    prompt: nextPrompt,
    removedToolExchanges: buildRemovedToolExchanges(prompt, nextPrompt, reason),
  };
}

export function partitionPromptForSummarization(
  prompt: LanguageModelV3Prompt,
  keepLastMessages: number,
  pinnedToolCallIds?: ReadonlySet<string>
): {
  systemMessages: LanguageModelV3Message[];
  summarizableMessages: LanguageModelV3Message[];
  preservedMessages: LanguageModelV3Message[];
} {
  const normalizedKeepLastMessages = Math.max(0, Math.floor(keepLastMessages));
  const tailStartIndex = computeTailStartIndex(prompt, normalizedKeepLastMessages);
  const pinnedMessageIndices = getPinnedMessageIndices(prompt, pinnedToolCallIds ?? new Set<string>());
  const preservedNonSystemIndices = new Set<number>(pinnedMessageIndices);

  for (let index = tailStartIndex; index < prompt.length; index++) {
    if (prompt[index].role !== "system") {
      preservedNonSystemIndices.add(index);
    }
  }

  const cloned = clonePrompt(prompt);
  const systemMessages: LanguageModelV3Message[] = [];
  const summarizableMessages: LanguageModelV3Message[] = [];
  const preservedMessages: LanguageModelV3Message[] = [];

  for (const [index, message] of cloned.entries()) {
    if (message.role === "system") {
      systemMessages.push(message);
      continue;
    }

    if (preservedNonSystemIndices.has(index)) {
      preservedMessages.push(message);
      continue;
    }

    summarizableMessages.push(message);
  }

  return {
    systemMessages,
    summarizableMessages,
    preservedMessages,
  };
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

  const insertIndex =
    cloned.reduce(
      (lastIndex, message, index) => (message.role === "system" ? index : lastIndex),
      -1
    ) + 1;
  cloned.splice(insertIndex, 0, buildReminderSystemMessage(reminderText));
  return cloned;
}
