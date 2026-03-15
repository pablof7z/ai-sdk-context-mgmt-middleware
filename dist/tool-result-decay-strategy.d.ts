import type { LanguageModelV3ToolResultOutput } from "@ai-sdk/provider";
import type { ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState, ToolResultDecayStrategyOptions } from "./types.js";
export declare function estimateOutputChars(output: LanguageModelV3ToolResultOutput): number;
export declare class ToolResultDecayStrategy implements ContextManagementStrategy {
    readonly name = "tool-result-decay";
    private readonly truncatedMaxTokens;
    private readonly placeholderFloorTokens;
    private readonly maxPromptTokens?;
    private readonly placeholder;
    private readonly decayInputs;
    private readonly estimator;
    constructor(options?: ToolResultDecayStrategyOptions);
    apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution>;
    private emitDecayWarning;
}
