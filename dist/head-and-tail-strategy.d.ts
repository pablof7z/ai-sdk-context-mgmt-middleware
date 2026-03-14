import type { ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState, HeadAndTailStrategyOptions } from "./types.js";
export declare class HeadAndTailStrategy implements ContextManagementStrategy {
    readonly name = "head-and-tail";
    private readonly headCount;
    private readonly tailCount;
    constructor(options?: HeadAndTailStrategyOptions);
    apply(state: ContextManagementStrategyState): ContextManagementStrategyExecution;
}
