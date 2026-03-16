import {
  collectToolExchanges,
  isContextManagementSystemMessage,
  partitionPromptForSummarization,
} from "../../prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "../../token-estimator.js";
import { createLlmSummarizer } from "../llm-summarization/index.js";
import type {
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  PromptTokenEstimator,
  RemovedToolExchange,
  SummarizationStrategyOptions,
} from "../../types.js";
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";

const DEFAULT_PRESERVE_RECENT_MESSAGES = 8;

function isSummaryMessage(message: LanguageModelV3Message): boolean {
  if (!isContextManagementSystemMessage(message)) {
    return false;
  }

  return (message.providerOptions?.contextManagement as Record<string, unknown>).type === "summary";
}

function resolveSummarize(
  options: SummarizationStrategyOptions
): NonNullable<SummarizationStrategyOptions["summarize"]> {
  if ("summarize" in options && typeof options.summarize === "function") {
    return options.summarize;
  }

  if ("model" in options && options.model) {
    return createLlmSummarizer({ model: options.model });
  }

  throw new Error("SummarizationStrategy requires either summarize or model");
}

export class SummarizationStrategy implements ContextManagementStrategy {
  readonly name = "summarization";
  private readonly summarize: NonNullable<SummarizationStrategyOptions["summarize"]>;
  private readonly maxPromptTokens: number;
  private readonly preserveRecentMessages: number;
  private readonly estimator: PromptTokenEstimator;

  constructor(options: SummarizationStrategyOptions) {
    this.summarize = resolveSummarize(options);
    this.maxPromptTokens = options.maxPromptTokens;
    this.preserveRecentMessages = Math.max(
      0,
      Math.floor(
        options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES
      )
    );
    this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
  }

  async apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution> {
    const estimatedTokens = this.estimator.estimatePrompt(state.prompt)
      + (this.estimator.estimateTools?.(state.params?.tools) ?? 0);

    if (estimatedTokens <= this.maxPromptTokens) {
      return {
        reason: "below-token-threshold",
        workingTokenBudget: this.maxPromptTokens,
        payloads: {
          estimatedTokens,
          preserveRecentMessages: this.preserveRecentMessages,
        },
      };
    }

    const prompt = state.prompt;
    const {
      systemMessages,
      summarizableMessages,
      preservedMessages,
    } = partitionPromptForSummarization(
      prompt,
      this.preserveRecentMessages,
      state.pinnedToolCallIds
    );

    if (summarizableMessages.length === 0) {
      return {
        reason: "no-summarizable-messages",
        workingTokenBudget: this.maxPromptTokens,
        payloads: {
          estimatedTokens,
          preserveRecentMessages: this.preserveRecentMessages,
          preservedMessageCount: preservedMessages.length,
        },
      };
    }

    const existingSummaryIndex = systemMessages.findIndex(isSummaryMessage);
    const existingSummary = existingSummaryIndex !== -1 ? systemMessages[existingSummaryIndex] : null;

    const messagesToSummarize: LanguageModelV3Message[] = [];
    if (existingSummary) {
      messagesToSummarize.push(existingSummary);
    }
    messagesToSummarize.push(...summarizableMessages);

    const summaryText = await this.summarize(messagesToSummarize);

    const summaryMessage: LanguageModelV3Message = {
      role: "system",
      content: summaryText,
      providerOptions: { contextManagement: { type: "summary" } },
    };

    const nonSummarySystemMessages = systemMessages.filter((_, i) => i !== existingSummaryIndex);
    const newPrompt: LanguageModelV3Prompt = [
      ...nonSummarySystemMessages,
      summaryMessage,
      ...preservedMessages,
    ];

    const originalExchanges = collectToolExchanges(prompt);
    const newExchanges = collectToolExchanges(newPrompt);
    const removedExchanges: RemovedToolExchange[] = [];

    for (const exchange of originalExchanges.values()) {
      if (!newExchanges.has(exchange.toolCallId)) {
        removedExchanges.push({
          toolCallId: exchange.toolCallId,
          toolName: exchange.toolName,
          reason: "summarization",
        });
      }
    }

    state.updatePrompt(newPrompt);
    state.addRemovedToolExchanges(removedExchanges);

    return {
      reason: "history-summarized",
      workingTokenBudget: this.maxPromptTokens,
      payloads: {
        estimatedTokens,
        preserveRecentMessages: this.preserveRecentMessages,
        messagesSummarizedCount: messagesToSummarize.length,
        summaryCharCount: summaryText.length,
      },
    };
  }
}
