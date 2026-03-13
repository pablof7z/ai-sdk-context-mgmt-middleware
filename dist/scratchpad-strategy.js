import { jsonSchema, tool } from "ai";
import { appendReminderToLatestUserMessage, removeToolExchanges, trimPromptToLastMessages, } from "./prompt-utils.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
const DEFAULT_MAX_SCRATCHPAD_CHARS = 1_200;
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
function truncateScratchpadNotes(notes, maxChars) {
    if (notes.length <= maxChars) {
        return notes;
    }
    if (maxChars <= 16) {
        return notes.slice(0, maxChars);
    }
    return `${notes.slice(0, maxChars - 15).trimEnd()}\n...[truncated]`;
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
    const { currentState, currentContext, otherScratchpads, removedToolExchanges, maxScratchpadChars, maxRemovedToolReminderItems, } = options;
    const lines = [
        "[Context management]",
        `Your scratchpad (${currentContext.agentLabel ?? currentContext.agentId}):`,
        truncateScratchpadNotes(currentState.notes, maxScratchpadChars) || "(empty)",
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
            lines.push(`- ${entry.agentLabel}: ${truncateScratchpadNotes(entry.notes, maxScratchpadChars)}`);
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
    lines.push("Use scratchpad(...) to update notes or proactively remove more context.");
    lines.push("[/Context management]");
    return lines.join("\n");
}
export class ScratchpadStrategy {
    name = "scratchpad";
    scratchpadStore;
    maxScratchpadChars;
    maxRemovedToolReminderItems;
    optionalTools;
    constructor(options) {
        this.scratchpadStore = options.scratchpadStore;
        this.maxScratchpadChars = options.maxScratchpadChars ?? DEFAULT_MAX_SCRATCHPAD_CHARS;
        this.maxRemovedToolReminderItems =
            options.maxRemovedToolReminderItems ?? DEFAULT_MAX_REMOVED_TOOL_REMINDER_ITEMS;
        this.optionalTools = {
            scratchpad: tool({
                description: "Update your scratchpad and proactively remove older context from future turns.",
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
        if (currentState.omitToolCallIds.length > 0) {
            const omissionResult = removeToolExchanges(state.prompt, currentState.omitToolCallIds, "scratchpad");
            state.updatePrompt(omissionResult.prompt);
            state.addRemovedToolExchanges(omissionResult.removedToolExchanges);
        }
        if (typeof currentState.keepLastMessages === "number") {
            const trimResult = trimPromptToLastMessages(state.prompt, currentState.keepLastMessages, "scratchpad");
            state.updatePrompt(trimResult.prompt);
            state.addRemovedToolExchanges(trimResult.removedToolExchanges);
        }
        const reminderBlock = buildReminderBlock({
            currentState,
            currentContext: state.requestContext,
            otherScratchpads: allScratchpads,
            removedToolExchanges: state.removedToolExchanges,
            maxScratchpadChars: this.maxScratchpadChars,
            maxRemovedToolReminderItems: this.maxRemovedToolReminderItems,
        });
        state.updatePrompt(appendReminderToLatestUserMessage(state.prompt, reminderBlock));
    }
}
