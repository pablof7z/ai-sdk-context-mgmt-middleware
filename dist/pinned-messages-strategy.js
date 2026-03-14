import { jsonSchema, tool } from "ai";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
const DEFAULT_MAX_PINNED = 10;
function extractRequestContextFromExperimentalContext(experimentalContext) {
    if (!experimentalContext ||
        typeof experimentalContext !== "object" ||
        !(CONTEXT_MANAGEMENT_KEY in experimentalContext)) {
        throw new Error("pin_tool_result tool requires experimental_context.contextManagement");
    }
    const raw = experimentalContext[CONTEXT_MANAGEMENT_KEY];
    if (!raw || typeof raw !== "object") {
        throw new Error("pin_tool_result tool requires a valid contextManagement request context");
    }
    const conversationId = raw.conversationId;
    const agentId = raw.agentId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
        throw new Error("pin_tool_result tool requires contextManagement.conversationId");
    }
    if (typeof agentId !== "string" || agentId.length === 0) {
        throw new Error("pin_tool_result tool requires contextManagement.agentId");
    }
    return { conversationId, agentId };
}
function buildPinnedKey(context) {
    return {
        conversationId: context.conversationId,
        agentId: context.agentId,
    };
}
export class PinnedMessagesStrategy {
    name = "pinned-messages";
    pinnedStore;
    maxPinned;
    optionalTools;
    constructor(options) {
        this.pinnedStore = options.pinnedStore;
        this.maxPinned = options.maxPinned ?? DEFAULT_MAX_PINNED;
        this.optionalTools = {
            pin_tool_result: tool({
                description: "Pin or unpin tool call results to protect them from being pruned by context management.",
                inputSchema: jsonSchema({
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        pin: {
                            type: "array",
                            items: { type: "string" },
                            description: "Tool call IDs to protect from pruning.",
                        },
                        unpin: {
                            type: "array",
                            items: { type: "string" },
                            description: "Tool call IDs to stop protecting from pruning.",
                        },
                    },
                }),
                execute: async (input, options) => {
                    const requestContext = extractRequestContextFromExperimentalContext(options.experimental_context);
                    const key = buildPinnedKey(requestContext);
                    const current = (await this.pinnedStore.get(key)) ?? [];
                    const unpinSet = new Set(input.unpin ?? []);
                    const filtered = current.filter((id) => !unpinSet.has(id));
                    const existingSet = new Set(filtered);
                    const toAdd = (input.pin ?? []).filter((id) => !existingSet.has(id));
                    const merged = [...filtered, ...toAdd];
                    const enforced = merged.length > this.maxPinned
                        ? merged.slice(merged.length - this.maxPinned)
                        : merged;
                    await this.pinnedStore.set(key, enforced);
                    return { ok: true, pinned: enforced };
                },
            }),
        };
    }
    getOptionalTools() {
        return this.optionalTools;
    }
    async apply(state) {
        const key = buildPinnedKey(state.requestContext);
        const pinnedIds = (await this.pinnedStore.get(key)) ?? [];
        if (pinnedIds.length > 0) {
            state.addPinnedToolCallIds(pinnedIds);
        }
        return {
            reason: pinnedIds.length > 0 ? "pinned-tool-results-loaded" : "no-pinned-tool-results",
            payloads: {
                pinnedToolCallIds: pinnedIds,
                maxPinned: this.maxPinned,
            },
        };
    }
}
