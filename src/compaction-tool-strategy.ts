import { jsonSchema, tool, type ToolSet } from "ai";
import {
  clonePrompt,
  collectToolExchanges,
  isContextManagementSystemMessage,
  partitionPromptForSummarization,
} from "./prompt-utils.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
import type {
  CompactionStore,
  CompactionStoreKey,
  CompactionToolStrategyOptions,
  ContextManagementRequestContext,
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  RemovedToolExchange,
} from "./types.js";
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";

const DEFAULT_KEEP_LAST_MESSAGES = 8;

function extractRequestContextFromExperimentalContext(
  experimentalContext: unknown
): ContextManagementRequestContext {
  if (
    !experimentalContext ||
    typeof experimentalContext !== "object" ||
    !(CONTEXT_MANAGEMENT_KEY in experimentalContext)
  ) {
    throw new Error("compact_context tool requires experimental_context.contextManagement");
  }

  const raw = (experimentalContext as Record<string, unknown>)[CONTEXT_MANAGEMENT_KEY];
  if (!raw || typeof raw !== "object") {
    throw new Error("compact_context tool requires a valid contextManagement request context");
  }

  const conversationId = (raw as Record<string, unknown>).conversationId;
  const agentId = (raw as Record<string, unknown>).agentId;

  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new Error("compact_context tool requires contextManagement.conversationId");
  }

  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new Error("compact_context tool requires contextManagement.agentId");
  }

  return { conversationId, agentId };
}

function buildCompactionKey(context: ContextManagementRequestContext): CompactionStoreKey {
  return {
    conversationId: context.conversationId,
    agentId: context.agentId,
  };
}

function buildCompactionRequestKey(context: ContextManagementRequestContext): string {
  return `${context.conversationId}:${context.agentId}`;
}

function buildSummarySystemMessage(summaryText: string): LanguageModelV3Message {
  return {
    role: "system",
    content: summaryText,
    providerOptions: { contextManagement: { type: "compaction-summary" } },
  };
}

function computeRemovedToolExchanges(
  originalPrompt: LanguageModelV3Prompt,
  nextPrompt: LanguageModelV3Prompt
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
      reason: "compaction",
    });
  }

  return removed;
}

function isCompactionSummaryMessage(message: LanguageModelV3Message): boolean {
  if (!isContextManagementSystemMessage(message)) {
    return false;
  }

  return (message.providerOptions?.contextManagement as Record<string, unknown>).type === "compaction-summary";
}

export class CompactionToolStrategy implements ContextManagementStrategy {
  readonly name = "compaction-tool";
  private readonly summarize: (messages: LanguageModelV3Message[]) => Promise<string>;
  private readonly keepLastMessages: number;
  private readonly compactionStore?: CompactionStore;
  private readonly optionalTools: ToolSet;
  private readonly pendingCompactionKeys = new Set<string>();

  constructor(options: CompactionToolStrategyOptions) {
    this.summarize = options.summarize;
    this.keepLastMessages = Math.max(0, Math.floor(options.keepLastMessages ?? DEFAULT_KEEP_LAST_MESSAGES));
    this.compactionStore = options.compactionStore;
    this.optionalTools = {
      compact_context: tool<Record<string, never>, { ok: true; message: string }>({
        description: "Compact the conversation context by summarizing older messages. Call this when the context is getting large.",
        inputSchema: jsonSchema({
          type: "object",
          additionalProperties: false,
          properties: {},
        }),
        execute: async (_input, options) => {
          const requestContext = extractRequestContextFromExperimentalContext(options.experimental_context);
          this.pendingCompactionKeys.add(buildCompactionRequestKey(requestContext));
          return {
            ok: true,
            message: "Context will be compacted before the next model call.",
          };
        },
      }),
    };
  }

  getOptionalTools(): ToolSet {
    return this.optionalTools;
  }

  async apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution> {
    const requestKey = buildCompactionRequestKey(state.requestContext);
    const hasPendingCompaction = this.pendingCompactionKeys.has(requestKey);

    if (this.compactionStore && !hasPendingCompaction) {
      const key = buildCompactionKey(state.requestContext);
      const storedSummary = await this.compactionStore.get(key);

      if (
        storedSummary &&
        !state.prompt.some((message) => isCompactionSummaryMessage(message))
      ) {
        const cloned = clonePrompt(state.prompt);
        const lastSystemIndex = cloned.reduce(
          (lastIndex, message, index) => (message.role === "system" ? index : lastIndex),
          -1
        );
        const insertIndex = lastSystemIndex + 1;
        cloned.splice(insertIndex, 0, buildSummarySystemMessage(storedSummary));
        state.updatePrompt(cloned);
        return {
          reason: "stored-compaction-summary-injected",
          payloads: {
            storedSummary,
          },
        };
      }
    }

    if (!hasPendingCompaction) {
      return {
        reason: "no-compaction-requested",
      };
    }

    const {
      systemMessages,
      summarizableMessages,
      preservedMessages,
    } = partitionPromptForSummarization(
      state.prompt,
      this.keepLastMessages,
      state.pinnedToolCallIds
    );

    if (summarizableMessages.length === 0) {
      this.pendingCompactionKeys.delete(requestKey);
      return {
        reason: "no-summarizable-messages",
        payloads: {
          keepLastMessages: this.keepLastMessages,
        },
      };
    }

    const existingSummaryIndex = systemMessages.findIndex(isCompactionSummaryMessage);
    const existingSummary = existingSummaryIndex === -1 ? null : systemMessages[existingSummaryIndex];
    const messagesToSummarize = existingSummary
      ? [existingSummary, ...summarizableMessages]
      : summarizableMessages;

    const summaryText = await this.summarize(messagesToSummarize);
    const summaryMessage = buildSummarySystemMessage(summaryText);

    const nonSummarySystemMessages = systemMessages.filter((_, index) => index !== existingSummaryIndex);
    const nextPrompt: LanguageModelV3Prompt = [
      ...nonSummarySystemMessages,
      summaryMessage,
      ...preservedMessages,
    ];

    const removedExchanges = computeRemovedToolExchanges(state.prompt, nextPrompt);
    state.addRemovedToolExchanges(removedExchanges);

    if (this.compactionStore) {
      const key = buildCompactionKey(state.requestContext);
      await this.compactionStore.set(key, summaryText);
    }

    state.updatePrompt(nextPrompt);
    this.pendingCompactionKeys.delete(requestKey);

    return {
      reason: "context-compacted",
      payloads: {
        keepLastMessages: this.keepLastMessages,
        messagesToSummarize,
        summaryText,
      },
    };
  }
}
