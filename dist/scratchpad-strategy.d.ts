import { type ToolSet } from "ai";
import type { ContextManagementStrategy, ContextManagementStrategyState, ScratchpadStrategyOptions } from "./types.js";
export declare class ScratchpadStrategy implements ContextManagementStrategy {
    readonly name = "scratchpad";
    private readonly scratchpadStore;
    private readonly maxScratchpadChars;
    private readonly maxRemovedToolReminderItems;
    private readonly optionalTools;
    constructor(options: ScratchpadStrategyOptions);
    getOptionalTools(): ToolSet;
    apply(state: ContextManagementStrategyState): Promise<void>;
}
