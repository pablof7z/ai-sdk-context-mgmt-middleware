import { type ToolSet } from "ai";
import type { ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState, ScratchpadStrategyOptions } from "./types.js";
export declare class ScratchpadStrategy implements ContextManagementStrategy {
    readonly name = "scratchpad";
    private readonly scratchpadStore;
    private readonly reminderTone;
    private readonly maxRemovedToolReminderItems;
    private readonly optionalTools;
    constructor(options: ScratchpadStrategyOptions);
    getOptionalTools(): ToolSet;
    apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution>;
}
