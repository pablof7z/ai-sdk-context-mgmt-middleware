import { trimPromptToLastMessages } from "../../prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "../../token-estimator.js";
const DEFAULT_KEEP_LAST_MESSAGES = 8;
export class SlidingWindowStrategy {
    name = "sliding-window";
    headCount;
    keepLastMessages;
    maxPromptTokens;
    estimator;
    constructor(options = {}) {
        this.headCount = Math.max(0, Math.floor(options.headCount ?? 0));
        this.keepLastMessages = Math.max(0, Math.floor(options.keepLastMessages ?? DEFAULT_KEEP_LAST_MESSAGES));
        this.maxPromptTokens = options.maxPromptTokens;
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    }
    apply(state) {
        const result = trimPromptToLastMessages(state.prompt, this.keepLastMessages, "sliding-window", {
            headCount: this.headCount,
            estimator: this.estimator,
            maxPromptTokens: this.maxPromptTokens,
            pinnedToolCallIds: state.pinnedToolCallIds,
        });
        const messagesRemoved = state.prompt.length - result.prompt.length;
        state.updatePrompt(result.prompt);
        state.addRemovedToolExchanges(result.removedToolExchanges);
        return {
            reason: messagesRemoved > 0
                ? this.headCount > 0 ? "window-trimmed" : "tail-trimmed"
                : "window-evaluated",
            workingTokenBudget: this.maxPromptTokens,
            payloads: {
                headCount: this.headCount,
                keepLastMessages: this.keepLastMessages,
                maxPromptTokens: this.maxPromptTokens,
                messagesRemoved,
            },
        };
    }
}
