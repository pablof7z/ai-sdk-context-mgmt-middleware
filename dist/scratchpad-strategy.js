import { jsonSchema, tool } from "ai";
import { appendReminderToLatestUserMessage, getLatestToolActivity, removeToolExchanges, trimPromptToLastMessages, } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
const DEFAULT_MAX_REMOVED_TOOL_REMINDER_ITEMS = 10;
function dedupeStrings(values) {
    const seen = new Set();
    const deduped = [];
    for (const value of values) {
        if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
            continue;
        }
        seen.add(value);
        deduped.push(value);
    }
    return deduped;
}
function normalizeKeepLastMessages(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    return Math.max(0, Math.floor(value));
}
function normalizeScratchpadState(state, agentLabel) {
    return {
        notes: state?.notes ?? "",
        keepLastMessages: normalizeKeepLastMessages(state?.keepLastMessages),
        omitToolCallIds: dedupeStrings(state?.omitToolCallIds ?? []),
        ...(typeof state?.updatedAt === "number" ? { updatedAt: state.updatedAt } : {}),
        ...(state?.agentLabel || agentLabel ? { agentLabel: state?.agentLabel ?? agentLabel } : {}),
    };
}
function buildScratchpadKey(context) {
    return {
        conversationId: context.conversationId,
        agentId: context.agentId,
    };
}
function extractRequestContextFromExperimentalContext(experimentalContext) {
    if (!experimentalContext ||
        typeof experimentalContext !== "object" ||
        !(CONTEXT_MANAGEMENT_KEY in experimentalContext)) {
        throw new Error("scratchpad tool requires experimental_context.contextManagement");
    }
    const raw = experimentalContext[CONTEXT_MANAGEMENT_KEY];
    if (!raw || typeof raw !== "object") {
        throw new Error("scratchpad tool requires a valid contextManagement request context");
    }
    const conversationId = raw.conversationId;
    const agentId = raw.agentId;
    const agentLabel = raw.agentLabel;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
        throw new Error("scratchpad tool requires contextManagement.conversationId");
    }
    if (typeof agentId !== "string" || agentId.length === 0) {
        throw new Error("scratchpad tool requires contextManagement.agentId");
    }
    return {
        conversationId,
        agentId,
        ...(typeof agentLabel === "string" && agentLabel.length > 0 ? { agentLabel } : {}),
    };
}
function buildReminderBlock(options) {
    const { currentState, currentContext, otherScratchpads, removedToolExchanges, reminderTone, maxRemovedToolReminderItems, } = options;
    const lines = [
        "[Context management]",
        `Your scratchpad (${currentContext.agentLabel ?? currentContext.agentId}):`,
        currentState.notes || "(empty)",
    ];
    const otherAgentNotes = otherScratchpads
        .map((entry) => ({
        agentLabel: entry.agentLabel ?? entry.state.agentLabel ?? entry.agentId,
        notes: entry.state.notes.trim(),
    }))
        .filter((entry) => entry.notes.length > 0);
    if (otherAgentNotes.length > 0) {
        lines.push("Other agent scratchpads:");
        for (const entry of otherAgentNotes) {
            lines.push(`- ${entry.agentLabel}: ${entry.notes}`);
        }
    }
    if (removedToolExchanges.length > 0) {
        const visible = removedToolExchanges.slice(0, maxRemovedToolReminderItems);
        lines.push("Removed tool exchanges:");
        for (const exchange of visible) {
            lines.push(`- ${exchange.toolName} (${exchange.toolCallId})`);
        }
        const overflow = removedToolExchanges.length - visible.length;
        if (overflow > 0) {
            lines.push(`and ${overflow} more`);
        }
    }
    if (reminderTone === "informational") {
        lines.push("You can update these notes or future omissions with scratchpad(...). Notes persist within this conversation only — they do not carry over to new conversations.");
    }
    else if (reminderTone === "urgent") {
        lines.push("Use scratchpad(...) now to preserve progress within this conversation or proactively remove stale context. Notes do not carry over to new conversations.");
    }
    lines.push("[/Context management]");
    return lines.join("\n");
}
export class ScratchpadStrategy {
    name = "scratchpad";
    scratchpadStore;
    reminderTone;
    maxRemovedToolReminderItems;
    workingTokenBudget;
    forceToolThresholdRatio;
    estimator;
    optionalTools;
    constructor(options) {
        const normalizedWorkingTokenBudget = typeof options.workingTokenBudget === "number"
            && Number.isFinite(options.workingTokenBudget)
            && options.workingTokenBudget > 0
            ? Math.floor(options.workingTokenBudget)
            : undefined;
        const normalizedForceThresholdRatio = typeof options.forceToolThresholdRatio === "number"
            && Number.isFinite(options.forceToolThresholdRatio)
            ? Math.min(1, Math.max(0, options.forceToolThresholdRatio))
            : undefined;
        if (normalizedForceThresholdRatio !== undefined && normalizedWorkingTokenBudget === undefined) {
            throw new Error("ScratchpadStrategy forceToolThresholdRatio requires workingTokenBudget");
        }
        this.scratchpadStore = options.scratchpadStore;
        this.reminderTone = options.reminderTone ?? "informational";
        this.maxRemovedToolReminderItems =
            options.maxRemovedToolReminderItems ?? DEFAULT_MAX_REMOVED_TOOL_REMINDER_ITEMS;
        this.workingTokenBudget = normalizedWorkingTokenBudget;
        this.forceToolThresholdRatio = normalizedForceThresholdRatio;
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
        this.optionalTools = {
            scratchpad: tool({
                description: "Update your scratchpad and proactively remove older context from future turns. Scratchpad notes persist within this conversation only — they do not carry over to new conversations.",
                inputSchema: jsonSchema({
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        notes: {
                            type: "string",
                            description: "Replacement scratchpad text for your agent.",
                        },
                        keepLastMessages: {
                            anyOf: [
                                {
                                    type: "integer",
                                    minimum: 0,
                                },
                                {
                                    type: "null",
                                },
                            ],
                            description: "Optional cap on visible non-system messages. Use null to clear it.",
                        },
                        omitToolCallIds: {
                            type: "array",
                            items: {
                                type: "string",
                            },
                            description: "Replacement list of tool call IDs to remove from future context.",
                        },
                    },
                }),
                execute: async (input, options) => {
                    const requestContext = extractRequestContextFromExperimentalContext(options.experimental_context);
                    const key = buildScratchpadKey(requestContext);
                    const currentState = normalizeScratchpadState(await this.scratchpadStore.get(key), requestContext.agentLabel);
                    const nextState = {
                        ...currentState,
                        ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
                        ...(input.keepLastMessages !== undefined
                            ? { keepLastMessages: normalizeKeepLastMessages(input.keepLastMessages) }
                            : {}),
                        ...(input.omitToolCallIds !== undefined
                            ? { omitToolCallIds: dedupeStrings(input.omitToolCallIds) }
                            : {}),
                        updatedAt: Date.now(),
                        ...(requestContext.agentLabel ? { agentLabel: requestContext.agentLabel } : {}),
                    };
                    await this.scratchpadStore.set(key, nextState);
                    return {
                        ok: true,
                        state: nextState,
                    };
                },
            }),
        };
    }
    getOptionalTools() {
        return this.optionalTools;
    }
    async apply(state) {
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
        if (typeof currentState.keepLastMessages === "number") {
            const trimResult = trimPromptToLastMessages(state.prompt, currentState.keepLastMessages, "scratchpad", {
                pinnedToolCallIds: state.pinnedToolCallIds,
            });
            state.updatePrompt(trimResult.prompt);
            state.addRemovedToolExchanges(trimResult.removedToolExchanges);
        }
        const reminderBlock = buildReminderBlock({
            currentState,
            currentContext: state.requestContext,
            otherScratchpads: allScratchpads,
            removedToolExchanges: state.removedToolExchanges,
            reminderTone: this.reminderTone,
            maxRemovedToolReminderItems: this.maxRemovedToolReminderItems,
        });
        state.updatePrompt(appendReminderToLatestUserMessage(state.prompt, reminderBlock));
        const estimatedTokens = this.estimator.estimatePrompt(state.prompt)
            + (this.estimator.estimateTools?.(state.params?.tools) ?? 0);
        const forceThresholdTokens = this.forceToolThresholdRatio !== undefined
            && this.workingTokenBudget !== undefined
            ? Math.floor(this.workingTokenBudget * this.forceToolThresholdRatio)
            : undefined;
        const latestToolActivity = getLatestToolActivity(state.prompt);
        const alreadyForcedToScratchpad = state.params?.toolChoice?.type === "tool"
            && state.params?.toolChoice?.toolName === "scratchpad";
        const justCalledScratchpad = latestToolActivity?.toolName === "scratchpad";
        const shouldForceToolChoice = forceThresholdTokens !== undefined
            && estimatedTokens >= forceThresholdTokens
            && !alreadyForcedToScratchpad
            && !justCalledScratchpad;
        if (shouldForceToolChoice) {
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
            ...(this.workingTokenBudget !== undefined ? { workingTokenBudget: this.workingTokenBudget } : {}),
            payloads: {
                currentState,
                otherScratchpads: allScratchpads,
                appliedOmitToolCallIds,
                appliedKeepLastMessages: currentState.keepLastMessages,
                reminderTone: this.reminderTone,
                reminderText: reminderBlock,
                estimatedTokens,
                forceToolThresholdRatio: this.forceToolThresholdRatio,
                forceThresholdTokens,
                forcedToolChoice: shouldForceToolChoice,
                latestToolActivity,
            },
        };
    }
}
