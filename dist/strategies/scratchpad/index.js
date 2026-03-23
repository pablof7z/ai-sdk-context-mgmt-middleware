import { getLatestToolActivity, projectScratchpadPrompt, removeToolExchanges, } from "../../prompt-utils.js";
import { estimateBudgetProfileTokens, normalizeContextBudgetProfile, } from "../../context-budget-profile.js";
import { createDefaultPromptTokenEstimator } from "../../token-estimator.js";
import { createScratchpadTool } from "./tools/scratchpad.js";
import { countEntryChars, indentMultiline, normalizeScratchpadState, renderScratchpadState, } from "./state.js";
function buildScratchpadKey(context) {
    return {
        conversationId: context.conversationId,
        agentId: context.agentId,
    };
}
function buildReminderBlock(options) {
    const { currentState, currentContext, otherScratchpads, reminderTone, emptyStateGuidanceLines, forced, } = options;
    const lines = [
        `Your scratchpad (${currentContext.agentLabel ?? currentContext.agentId}):`,
        ...renderScratchpadState(currentState),
    ];
    const otherAgentNotes = otherScratchpads
        .map((entry) => ({
        agentLabel: entry.agentLabel ?? entry.state.agentLabel ?? entry.agentId,
        body: renderScratchpadState(normalizeScratchpadState(entry.state)),
    }))
        .filter((entry) => entry.body.length > 0 && !(entry.body.length === 1 && entry.body[0] === "(empty)"));
    if (otherAgentNotes.length > 0) {
        lines.push("Other agent scratchpads:");
        for (const entry of otherAgentNotes) {
            lines.push(`- ${entry.agentLabel}:`);
            lines.push(indentMultiline(entry.body.join("\n")));
        }
    }
    if (forced) {
        lines.push("CRITICAL: Context is nearly full. You MUST:", "1. Record side-effect actions in your scratchpad entries", "2. Set preserveTurns to compact older turns (e.g. 2-4)", "3. Add completed tool call IDs to omitToolCallIds", "Failure to free context will result in an error.");
    }
    else if (reminderTone === "informational") {
        if ((currentState.entries === undefined || Object.keys(currentState.entries).length === 0)
            && emptyStateGuidanceLines.length > 0) {
            lines.push(...emptyStateGuidanceLines);
        }
        lines.push("Use scratchpad(...) proactively to keep this working state current. Prefer rewriting stale entries over keeping a chronological log. Scratchpad entries persist within this conversation only — they do not carry over to new conversations.");
    }
    else if (reminderTone === "urgent") {
        lines.push("Use scratchpad(...) now to rewrite your current working state, preserve progress within this conversation, or proactively remove stale context. Scratchpad entries do not carry over to new conversations.");
    }
    return lines.join("\n");
}
export class ScratchpadStrategy {
    name = "scratchpad";
    scratchpadStore;
    reminderTone;
    emptyStateGuidanceLines;
    budgetProfile;
    forceToolThresholdRatio;
    estimator = createDefaultPromptTokenEstimator();
    optionalTools;
    forcedOnLastApply = false;
    constructor(options) {
        const normalizedBudgetProfile = normalizeContextBudgetProfile(options.budgetProfile);
        const normalizedForceThresholdRatio = typeof options.forceToolThresholdRatio === "number"
            && Number.isFinite(options.forceToolThresholdRatio)
            ? Math.min(1, Math.max(0, options.forceToolThresholdRatio))
            : undefined;
        if (normalizedForceThresholdRatio !== undefined && normalizedBudgetProfile === undefined) {
            throw new Error("ScratchpadStrategy forceToolThresholdRatio requires budgetProfile");
        }
        this.scratchpadStore = options.scratchpadStore;
        this.reminderTone = options.reminderTone ?? "informational";
        this.emptyStateGuidanceLines = (Array.isArray(options.emptyStateGuidance)
            ? options.emptyStateGuidance
            : typeof options.emptyStateGuidance === "string"
                ? [options.emptyStateGuidance]
                : [])
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        this.budgetProfile = normalizedBudgetProfile;
        this.forceToolThresholdRatio = normalizedForceThresholdRatio;
        this.optionalTools = {
            scratchpad: createScratchpadTool({
                scratchpadStore: this.scratchpadStore,
                consumeForcedCall: () => {
                    const wasForcedCall = this.forcedOnLastApply;
                    this.forcedOnLastApply = false;
                    return wasForcedCall;
                },
            }),
        };
    }
    getOptionalTools() {
        return this.optionalTools;
    }
    async apply(state) {
        const latestToolActivity = getLatestToolActivity(state.prompt);
        const [currentStateRaw, allScratchpadsRaw] = await Promise.all([
            this.scratchpadStore.get(buildScratchpadKey(state.requestContext)),
            this.scratchpadStore.listConversation(state.requestContext.conversationId),
        ]);
        const currentState = normalizeScratchpadState(currentStateRaw, state.requestContext.agentLabel);
        const allScratchpads = (allScratchpadsRaw ?? []).filter((entry) => entry.agentId !== state.requestContext.agentId);
        let appliedOmitToolCallIds = [];
        if (currentState.omitToolCallIds.length > 0) {
            const omitToolCallIds = currentState.omitToolCallIds.filter((toolCallId) => !state.pinnedToolCallIds.has(toolCallId));
            appliedOmitToolCallIds = omitToolCallIds;
            const omissionResult = removeToolExchanges(state.prompt, omitToolCallIds, "scratchpad");
            state.updatePrompt(omissionResult.prompt);
            state.addRemovedToolExchanges(omissionResult.removedToolExchanges);
        }
        state.updatePrompt(projectScratchpadPrompt(state.prompt, {
            preserveTurns: currentState.preserveTurns,
            notice: currentState.activeNotice,
        }));
        const estimatedTokens = this.budgetProfile
            ? estimateBudgetProfileTokens(this.budgetProfile, state.prompt, state.params?.tools)
            : this.estimator.estimatePrompt(state.prompt)
                + (this.estimator.estimateTools?.(state.params?.tools) ?? 0);
        const forceThresholdTokens = this.forceToolThresholdRatio !== undefined
            && this.budgetProfile !== undefined
            ? Math.floor(this.budgetProfile.tokenBudget * this.forceToolThresholdRatio)
            : undefined;
        const alreadyForcedToScratchpad = state.params?.toolChoice?.type === "tool"
            && state.params?.toolChoice?.toolName === "scratchpad";
        const justCalledScratchpad = latestToolActivity?.toolName === "scratchpad";
        const shouldForceToolChoice = forceThresholdTokens !== undefined
            && estimatedTokens >= forceThresholdTokens
            && !alreadyForcedToScratchpad
            && !justCalledScratchpad;
        const reminderBlock = buildReminderBlock({
            currentState,
            currentContext: state.requestContext,
            otherScratchpads: allScratchpads,
            reminderTone: this.reminderTone,
            emptyStateGuidanceLines: this.emptyStateGuidanceLines,
            forced: shouldForceToolChoice,
        });
        await state.emitReminder({
            kind: "scratchpad",
            content: reminderBlock,
        });
        if (shouldForceToolChoice) {
            this.forcedOnLastApply = true;
            state.updateParams({
                toolChoice: {
                    type: "tool",
                    toolName: "scratchpad",
                },
            });
        }
        return {
            outcome: shouldForceToolChoice ? "applied" : undefined,
            reason: shouldForceToolChoice
                ? "scratchpad-rendered-and-tool-forced"
                : "scratchpad-rendered",
            ...(this.budgetProfile !== undefined ? { workingTokenBudget: this.budgetProfile.tokenBudget } : {}),
            payloads: {
                kind: "scratchpad",
                entryCount: Object.keys(currentState.entries ?? {}).length,
                entryCharCount: countEntryChars(currentState.entries),
                preserveTurns: currentState.preserveTurns,
                activeNoticeDescription: currentState.activeNotice?.description,
                activeNoticeToolCallId: currentState.activeNotice?.toolCallId,
                activeNoticeRawTurnCountAtCall: currentState.activeNotice?.rawTurnCountAtCall,
                activeNoticeProjectedTurnCountAtCall: currentState.activeNotice?.projectedTurnCountAtCall,
                appliedOmitCount: appliedOmitToolCallIds.length,
                otherScratchpadCount: allScratchpads.length,
                reminderTone: this.reminderTone,
                estimatedTokens,
                forceToolThresholdRatio: this.forceToolThresholdRatio,
                forceThresholdTokens,
                forcedToolChoice: shouldForceToolChoice,
                latestToolName: latestToolActivity?.toolName,
            },
        };
    }
}
