import { type ToolSet } from "ai";
import type { CompactionToolStrategyOptions, ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState } from "./types.js";
export declare class CompactionToolStrategy implements ContextManagementStrategy {
    readonly name = "compaction-tool";
    private readonly summarize;
    private readonly keepLastMessages;
    private readonly compactionStore?;
    private readonly optionalTools;
    private readonly pendingCompactionKeys;
    constructor(options: CompactionToolStrategyOptions);
    getOptionalTools(): ToolSet;
    apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution>;
}
