import type { ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState, SummarizationStrategyOptions } from "./types.js";
export declare class SummarizationStrategy implements ContextManagementStrategy {
    readonly name = "summarization";
    private readonly summarize;
    private readonly maxPromptTokens;
    private readonly keepLastMessages;
    private readonly estimator;
    constructor(options: SummarizationStrategyOptions);
    apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution>;
}
