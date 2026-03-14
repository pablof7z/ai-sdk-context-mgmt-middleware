import { clonePrompt, collectToolExchanges } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
const DEFAULT_KEEP_FULL_RESULT_COUNT = 3;
const DEFAULT_TRUNCATED_MAX_TOKENS = 200;
const DEFAULT_TRUNCATE_WINDOW_COUNT = 5;
const DEFAULT_PLACEHOLDER = "[result omitted]";
const CHARS_PER_TOKEN = 4;
export class ToolResultDecayStrategy {
    name = "tool-result-decay";
    keepFullResultCount;
    truncatedMaxTokens;
    truncateWindowCount;
    maxPromptTokens;
    placeholder;
    estimator;
    constructor(options = {}) {
        this.keepFullResultCount = Math.max(0, Math.floor(options.keepFullResultCount ?? DEFAULT_KEEP_FULL_RESULT_COUNT));
        this.truncatedMaxTokens = Math.max(0, Math.floor(options.truncatedMaxTokens ?? DEFAULT_TRUNCATED_MAX_TOKENS));
        this.truncateWindowCount = Math.max(0, Math.floor(options.truncateWindowCount ?? DEFAULT_TRUNCATE_WINDOW_COUNT));
        this.maxPromptTokens = options.maxPromptTokens;
        this.placeholder = options.placeholder ?? DEFAULT_PLACEHOLDER;
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    }
    apply(state) {
        const currentPromptTokens = this.estimator.estimatePrompt(state.prompt)
            + (this.estimator.estimateTools?.(state.params?.tools) ?? 0);
        if (this.maxPromptTokens !== undefined &&
            currentPromptTokens <= this.maxPromptTokens) {
            return {
                reason: "below-token-threshold",
                workingTokenBudget: this.maxPromptTokens,
                payloads: {
                    currentPromptTokens,
                    keepFullResultCount: this.keepFullResultCount,
                    truncateWindowCount: this.truncateWindowCount,
                    truncatedMaxTokens: this.truncatedMaxTokens,
                },
            };
        }
        const exchanges = collectToolExchanges(state.prompt);
        if (exchanges.size === 0) {
            return {
                reason: "no-tool-exchanges",
                workingTokenBudget: this.maxPromptTokens,
                payloads: {
                    currentPromptTokens,
                    keepFullResultCount: this.keepFullResultCount,
                    truncateWindowCount: this.truncateWindowCount,
                    truncatedMaxTokens: this.truncatedMaxTokens,
                },
            };
        }
        // Sort exchanges by their result message position, most recent last.
        // Use the maximum result message index for ordering.
        const sorted = [...exchanges.values()].sort((a, b) => {
            const aMax = Math.max(...a.resultMessageIndices, a.callMessageIndex ?? -1);
            const bMax = Math.max(...b.resultMessageIndices, b.callMessageIndex ?? -1);
            return aMax - bMax;
        });
        // Assign positions from the end: position 0 = most recent
        const positionFromEnd = new Map();
        for (let i = 0; i < sorted.length; i++) {
            positionFromEnd.set(sorted[i].toolCallId, sorted.length - 1 - i);
        }
        // Classify each exchange into a zone
        const truncateIds = new Set();
        const placeholderIds = new Set();
        for (const exchange of sorted) {
            if (state.pinnedToolCallIds.has(exchange.toolCallId)) {
                continue;
            }
            const position = positionFromEnd.get(exchange.toolCallId);
            if (position < this.keepFullResultCount) {
                // Full zone - untouched
                continue;
            }
            if (position < this.keepFullResultCount + this.truncateWindowCount) {
                truncateIds.add(exchange.toolCallId);
            }
            else {
                placeholderIds.add(exchange.toolCallId);
            }
        }
        if (truncateIds.size === 0 && placeholderIds.size === 0) {
            return {
                reason: "no-eligible-tool-exchanges",
                workingTokenBudget: this.maxPromptTokens,
                payloads: {
                    currentPromptTokens,
                    keepFullResultCount: this.keepFullResultCount,
                    truncateWindowCount: this.truncateWindowCount,
                    truncatedMaxTokens: this.truncatedMaxTokens,
                },
            };
        }
        const prompt = clonePrompt(state.prompt);
        const maxChars = this.truncatedMaxTokens * CHARS_PER_TOKEN;
        const removedExchanges = [];
        for (const message of prompt) {
            if (message.role !== "tool" && message.role !== "assistant") {
                continue;
            }
            for (const part of message.content) {
                if (part.type !== "tool-result") {
                    continue;
                }
                if (truncateIds.has(part.toolCallId)) {
                    if (part.output.type === "text" && typeof part.output.value === "string" && part.output.value.length > maxChars) {
                        part.output = { type: "text", value: part.output.value.slice(0, maxChars) };
                    }
                }
                else if (placeholderIds.has(part.toolCallId)) {
                    const placeholderText = typeof this.placeholder === "function"
                        ? this.placeholder(part.toolName, part.toolCallId)
                        : this.placeholder;
                    part.output = { type: "text", value: placeholderText };
                    removedExchanges.push({
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        reason: "tool-result-decay",
                    });
                }
            }
        }
        state.updatePrompt(prompt);
        state.addRemovedToolExchanges(removedExchanges);
        return {
            reason: "tool-results-decayed",
            workingTokenBudget: this.maxPromptTokens,
            payloads: {
                currentPromptTokens,
                keepFullResultCount: this.keepFullResultCount,
                truncateWindowCount: this.truncateWindowCount,
                truncatedMaxTokens: this.truncatedMaxTokens,
                truncatedToolCallIds: [...truncateIds],
                placeholderToolCallIds: [...placeholderIds],
            },
        };
    }
}
