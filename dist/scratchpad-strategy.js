import { jsonSchema, tool } from "ai";
import { getLatestToolActivity, removeToolExchanges, trimPromptHeadAndTail, } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
const DEFAULT_PRESERVE_HEAD_COUNT = 2;
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
    const { currentState, currentContext, otherScratchpads, reminderTone, forced, } = options;
    const lines = [
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
    if (forced) {
        lines.push("CRITICAL: Context is nearly full. You MUST:", "1. Record any side-effect actions in notes (file writes, API calls, etc.)", "2. Set keepLastMessages to trim old messages (e.g. 5-10)", "3. Add completed tool call IDs to omitToolCallIds", "Failure to free context will result in an error.");
    }
    else if (reminderTone === "informational") {
        lines.push("You can update these notes or future omissions with scratchpad(...). Notes persist within this conversation only — they do not carry over to new conversations.");
    }
    else if (reminderTone === "urgent") {
        lines.push("Use scratchpad(...) now to preserve progress within this conversation or proactively remove stale context. Notes do not carry over to new conversations.");
    }
    return lines.join("\n");
}
export class ScratchpadStrategy {
    name = "scratchpad";
    scratchpadStore;
    reminderTone;
    workingTokenBudget;
    forceToolThresholdRatio;
    preserveHeadCount;
    estimator;
    optionalTools;
    forcedOnLastApply = false;
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
        this.workingTokenBudget = normalizedWorkingTokenBudget;
        this.forceToolThresholdRatio = normalizedForceThresholdRatio;
        this.preserveHeadCount = Math.max(0, Math.floor(options.preserveHeadCount ?? DEFAULT_PRESERVE_HEAD_COUNT));
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
        this.optionalTools = {
            scratchpad: tool({
                description: "Manage your working memory and context window. Use notes to persist information across context pruning. Use keepLastMessages and omitToolCallIds to free context when it grows too large.\n\nIMPORTANT: Before pruning context, record in your notes any actions you took that had side effects (file writes, API calls, published events, state changes) so you don't forget or repeat them.\n\nkeepLastMessages preserves the original conversation start and your most recent N messages, removing everything in between.",
                inputSchema: jsonSchema({
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        notes: {
                            type: "string",
                            description: "Your working memory. Record task objectives, progress, and importantly any actions with side effects (file writes, API calls, state changes). This persists even when messages are pruned.",
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
                            description: "Number of recent non-system messages to keep. The conversation start (original task) is always preserved. Messages in between are dropped. Use null to clear.",
                        },
                        omitToolCallIds: {
                            type: "array",
                            items: {
                                type: "string",
                            },
                            description: "Tool call IDs whose request and result should be removed from context. Use for completed tool calls whose results you've already captured in notes.",
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
                    // Check if this was a forced call and the agent didn't provide pruning params
                    const wasForcedCall = this.forcedOnLastApply;
                    this.forcedOnLastApply = false;
                    if (wasForcedCall) {
                        const hasPruningParams = input.keepLastMessages !== undefined
                            || (input.omitToolCallIds !== undefined && input.omitToolCallIds.length > 0);
                        if (!hasPruningParams) {
                            return {
                                ok: false,
                                error: "Context is critically full. You MUST free context by setting keepLastMessages (integer) to trim old messages, and/or omitToolCallIds (array of tool call IDs) to remove completed tool results. Notes were saved, but you need to call scratchpad again with pruning parameters.",
                                state: nextState,
                            };
                        }
                    }
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
            const trimResult = trimPromptHeadAndTail(state.prompt, this.preserveHeadCount, currentState.keepLastMessages, "scratchpad", {
                pinnedToolCallIds: state.pinnedToolCallIds,
            });
            state.updatePrompt(trimResult.prompt);
            state.addRemovedToolExchanges(trimResult.removedToolExchanges);
        }
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
        const reminderBlock = buildReminderBlock({
            currentState,
            currentContext: state.requestContext,
            otherScratchpads: allScratchpads,
            reminderTone: this.reminderTone,
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
            ...(this.workingTokenBudget !== undefined ? { workingTokenBudget: this.workingTokenBudget } : {}),
            payloads: {
                notesCharCount: currentState.notes.length,
                keepLastMessages: currentState.keepLastMessages,
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
