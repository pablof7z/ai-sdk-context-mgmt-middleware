import type { ToolSet } from "ai";
import type { ContextManagementStrategy, ContextManagementStrategyExecution, ContextManagementStrategyState, ScratchpadStrategyOptions } from "../../types.js";
export declare class ScratchpadStrategy implements ContextManagementStrategy {
    readonly name = "scratchpad";
    private readonly scratchpadStore;
    private readonly reminderTone;
    private readonly emptyStateGuidanceLines;
    private readonly budgetProfile?;
    private readonly forceToolThresholdRatio?;
    private readonly estimator;
    private readonly optionalTools;
    private forcedOnLastApply;
    constructor(options: ScratchpadStrategyOptions);
    getOptionalTools(): ToolSet;
    apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution>;
}
