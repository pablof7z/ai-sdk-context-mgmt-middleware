import type { ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState, ToolResultDecayStrategyOptions } from "./types.js";
export declare class ToolResultDecayStrategy implements ContextManagementStrategy {
    readonly name = "tool-result-decay";
    private readonly keepFullResultCount;
    private readonly truncatedMaxTokens;
    private readonly truncateWindowCount;
    private readonly maxPromptTokens?;
    private readonly placeholder;
    private readonly estimator;
    constructor(options?: ToolResultDecayStrategyOptions);
    apply(state: ContextManagementStrategyState): ContextManagementStrategyExecution;
}
