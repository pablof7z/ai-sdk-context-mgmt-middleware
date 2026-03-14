import type { ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState, ContextWindowStatusStrategyOptions } from "./types.js";
export declare class ContextWindowStatusStrategy implements ContextManagementStrategy {
    readonly name = "context-window-status";
    private readonly workingTokenBudget?;
    private readonly estimator;
    private readonly getContextWindow?;
    constructor(options?: ContextWindowStatusStrategyOptions);
    apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution>;
}
