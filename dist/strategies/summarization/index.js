import { collectToolExchanges, isContextManagementSystemMessage, partitionPromptForSummarization, } from "../../prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "../../token-estimator.js";
import { createLlmSummarizer } from "../llm-summarization/index.js";
const DEFAULT_PRESERVE_RECENT_MESSAGES = 8;
function isSummaryMessage(message) {
    if (!isContextManagementSystemMessage(message)) {
        return false;
    }
    return (message.providerOptions?.contextManagement).type === "summary";
}
function resolveSummarize(options) {
    if ("summarize" in options && typeof options.summarize === "function") {
        return options.summarize;
    }
    if ("model" in options && options.model) {
        return createLlmSummarizer({ model: options.model });
    }
    throw new Error("SummarizationStrategy requires either summarize or model");
}
export class SummarizationStrategy {
    name = "summarization";
    summarize;
    maxPromptTokens;
    preserveRecentMessages;
    estimator;
    constructor(options) {
        this.summarize = resolveSummarize(options);
        this.maxPromptTokens = options.maxPromptTokens;
        this.preserveRecentMessages = Math.max(0, Math.floor(options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES));
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
                    preserveRecentMessages: this.preserveRecentMessages,
                },
            };
        }
        const prompt = state.prompt;
        const { systemMessages, summarizableMessages, preservedMessages, } = partitionPromptForSummarization(prompt, this.preserveRecentMessages, state.pinnedToolCallIds);
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
                preserveRecentMessages: this.preserveRecentMessages,
                messagesSummarizedCount: messagesToSummarize.length,
                summaryCharCount: summaryText.length,
            },
        };
    }
}
