import type { ContextManagementStrategy, ContextManagementStrategyState, SlidingWindowStrategyOptions } from "./types.js";
export declare class SlidingWindowStrategy implements ContextManagementStrategy {
    readonly name = "sliding-window";
    private readonly keepLastMessages;
    private readonly maxPromptTokens?;
    private readonly estimator;
    constructor(options?: SlidingWindowStrategyOptions);
    apply(state: ContextManagementStrategyState): void;
}
