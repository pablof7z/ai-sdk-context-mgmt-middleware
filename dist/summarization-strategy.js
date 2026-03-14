import { collectToolExchanges, isContextManagementSystemMessage, partitionPromptForSummarization, } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
const DEFAULT_KEEP_LAST_MESSAGES = 8;
function isSummaryMessage(message) {
    if (!isContextManagementSystemMessage(message)) {
        return false;
    }
    return (message.providerOptions?.contextManagement).type === "summary";
}
export class SummarizationStrategy {
    name = "summarization";
    summarize;
    maxPromptTokens;
    keepLastMessages;
    estimator;
    constructor(options) {
        this.summarize = options.summarize;
        this.maxPromptTokens = options.maxPromptTokens;
        this.keepLastMessages = Math.max(0, Math.floor(options.keepLastMessages ?? DEFAULT_KEEP_LAST_MESSAGES));
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    }
    async apply(state) {
        const estimatedTokens = this.estimator.estimatePrompt(state.prompt)
            + (this.estimator.estimateTools?.(state.params?.tools) ?? 0);
        if (estimatedTokens <= this.maxPromptTokens) {
            return {
                reason: "below-token-threshold",
                workingTokenBudget: this.maxPromptTokens,
                payloads: {
                    estimatedTokens,
                    keepLastMessages: this.keepLastMessages,
                },
            };
        }
        const prompt = state.prompt;
        const { systemMessages, summarizableMessages, preservedMessages, } = partitionPromptForSummarization(prompt, this.keepLastMessages, state.pinnedToolCallIds);
        if (summarizableMessages.length === 0) {
            return {
                reason: "no-summarizable-messages",
                workingTokenBudget: this.maxPromptTokens,
                payloads: {
                    estimatedTokens,
                    keepLastMessages: this.keepLastMessages,
                    preservedMessageCount: preservedMessages.length,
                },
            };
        }
        const existingSummaryIndex = systemMessages.findIndex(isSummaryMessage);
        const existingSummary = existingSummaryIndex !== -1 ? systemMessages[existingSummaryIndex] : null;
        const messagesToSummarize = [];
        if (existingSummary) {
            messagesToSummarize.push(existingSummary);
        }
        messagesToSummarize.push(...summarizableMessages);
        const summaryText = await this.summarize(messagesToSummarize);
        const summaryMessage = {
            role: "system",
            content: summaryText,
            providerOptions: { contextManagement: { type: "summary" } },
        };
        const nonSummarySystemMessages = systemMessages.filter((_, i) => i !== existingSummaryIndex);
        const newPrompt = [
            ...nonSummarySystemMessages,
            summaryMessage,
            ...preservedMessages,
        ];
        const originalExchanges = collectToolExchanges(prompt);
        const newExchanges = collectToolExchanges(newPrompt);
        const removedExchanges = [];
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
                keepLastMessages: this.keepLastMessages,
                messagesToSummarize,
                summaryText,
            },
        };
    }
}
