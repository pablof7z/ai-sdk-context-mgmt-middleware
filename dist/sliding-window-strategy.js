import { trimPromptToLastMessages } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
const DEFAULT_KEEP_LAST_MESSAGES = 8;
export class SlidingWindowStrategy {
    name = "sliding-window";
    keepLastMessages;
    maxPromptTokens;
    estimator;
    constructor(options = {}) {
        this.keepLastMessages = Math.max(0, Math.floor(options.keepLastMessages ?? DEFAULT_KEEP_LAST_MESSAGES));
        this.maxPromptTokens = options.maxPromptTokens;
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    }
    apply(state) {
        const result = trimPromptToLastMessages(state.prompt, this.keepLastMessages, "sliding-window", {
            estimator: this.estimator,
            maxPromptTokens: this.maxPromptTokens,
            pinnedToolCallIds: state.pinnedToolCallIds,
        });
        const messagesRemoved = state.prompt.length - result.prompt.length;
        state.updatePrompt(result.prompt);
        state.addRemovedToolExchanges(result.removedToolExchanges);
        return {
            reason: result.removedToolExchanges.length > 0 ? "tail-trimmed" : "window-evaluated",
            workingTokenBudget: this.maxPromptTokens,
            payloads: {
                keepLastMessages: this.keepLastMessages,
                maxPromptTokens: this.maxPromptTokens,
                messagesRemoved,
            },
        };
    }
}
