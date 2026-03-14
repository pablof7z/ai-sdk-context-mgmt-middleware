import type { ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState, SystemPromptCachingStrategyOptions } from "./types.js";
export declare class SystemPromptCachingStrategy implements ContextManagementStrategy {
    readonly name = "system-prompt-caching";
    private readonly consolidateSystemMessages;
    constructor(options?: SystemPromptCachingStrategyOptions);
    apply(state: ContextManagementStrategyState): ContextManagementStrategyExecution;
}
