import { trimPromptToLastMessages } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import type {
  ContextManagementStrategy,
  ContextManagementStrategyState,
  SlidingWindowStrategyOptions,
} from "./types.js";

const DEFAULT_KEEP_LAST_MESSAGES = 8;

export class SlidingWindowStrategy implements ContextManagementStrategy {
  readonly name = "sliding-window";
  private readonly keepLastMessages: number;
  private readonly maxPromptTokens?: number;
  private readonly estimator;

  constructor(options: SlidingWindowStrategyOptions = {}) {
    this.keepLastMessages = Math.max(0, Math.floor(options.keepLastMessages ?? DEFAULT_KEEP_LAST_MESSAGES));
    this.maxPromptTokens = options.maxPromptTokens;
    this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
  }

  apply(state: ContextManagementStrategyState): void {
    const result = trimPromptToLastMessages(
      state.prompt,
      this.keepLastMessages,
      "sliding-window",
      {
        estimator: this.estimator,
        maxPromptTokens: this.maxPromptTokens,
      }
    );

    state.updatePrompt(result.prompt);
    state.addRemovedToolExchanges(result.removedToolExchanges);
  }
}
