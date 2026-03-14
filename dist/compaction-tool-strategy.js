import { jsonSchema, tool } from "ai";
import { clonePrompt, collectToolExchanges, isContextManagementSystemMessage, partitionPromptForSummarization, } from "./prompt-utils.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
const DEFAULT_KEEP_LAST_MESSAGES = 8;
function extractRequestContextFromExperimentalContext(experimentalContext) {
    if (!experimentalContext ||
        typeof experimentalContext !== "object" ||
        !(CONTEXT_MANAGEMENT_KEY in experimentalContext)) {
        throw new Error("compact_context tool requires experimental_context.contextManagement");
    }
    const raw = experimentalContext[CONTEXT_MANAGEMENT_KEY];
    if (!raw || typeof raw !== "object") {
        throw new Error("compact_context tool requires a valid contextManagement request context");
    }
    const conversationId = raw.conversationId;
    const agentId = raw.agentId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
        throw new Error("compact_context tool requires contextManagement.conversationId");
    }
    if (typeof agentId !== "string" || agentId.length === 0) {
        throw new Error("compact_context tool requires contextManagement.agentId");
    }
    return { conversationId, agentId };
}
function buildCompactionKey(context) {
    return {
        conversationId: context.conversationId,
        agentId: context.agentId,
    };
}
function buildCompactionRequestKey(context) {
    return `${context.conversationId}:${context.agentId}`;
}
function buildSummarySystemMessage(summaryText) {
    return {
        role: "system",
        content: summaryText,
        providerOptions: { contextManagement: { type: "compaction-summary" } },
    };
}
function computeRemovedToolExchanges(originalPrompt, nextPrompt) {
    const original = collectToolExchanges(originalPrompt);
    const next = collectToolExchanges(nextPrompt);
    const removed = [];
    for (const exchange of original.values()) {
        if (next.has(exchange.toolCallId)) {
            continue;
        }
        removed.push({
            toolCallId: exchange.toolCallId,
            toolName: exchange.toolName,
            reason: "compaction",
        });
    }
    return removed;
}
function isCompactionSummaryMessage(message) {
    if (!isContextManagementSystemMessage(message)) {
        return false;
    }
    return (message.providerOptions?.contextManagement).type === "compaction-summary";
}
export class CompactionToolStrategy {
    name = "compaction-tool";
    summarize;
    keepLastMessages;
    compactionStore;
    optionalTools;
    pendingCompactionKeys = new Set();
    constructor(options) {
        this.summarize = options.summarize;
        this.keepLastMessages = Math.max(0, Math.floor(options.keepLastMessages ?? DEFAULT_KEEP_LAST_MESSAGES));
        this.compactionStore = options.compactionStore;
        this.optionalTools = {
            compact_context: tool({
                description: "Compact the conversation context by summarizing older messages. Call this when the context is getting large.",
                inputSchema: jsonSchema({
                    type: "object",
                    additionalProperties: false,
                    properties: {},
                }),
                execute: async (_input, options) => {
                    const requestContext = extractRequestContextFromExperimentalContext(options.experimental_context);
                    this.pendingCompactionKeys.add(buildCompactionRequestKey(requestContext));
                    return {
                        ok: true,
                        message: "Context will be compacted before the next model call.",
                    };
                },
            }),
        };
    }
    getOptionalTools() {
        return this.optionalTools;
    }
    async apply(state) {
        const requestKey = buildCompactionRequestKey(state.requestContext);
        const hasPendingCompaction = this.pendingCompactionKeys.has(requestKey);
        if (this.compactionStore && !hasPendingCompaction) {
            const key = buildCompactionKey(state.requestContext);
            const storedSummary = await this.compactionStore.get(key);
            if (storedSummary &&
                !state.prompt.some((message) => isCompactionSummaryMessage(message))) {
                const cloned = clonePrompt(state.prompt);
                const lastSystemIndex = cloned.reduce((lastIndex, message, index) => (message.role === "system" ? index : lastIndex), -1);
                const insertIndex = lastSystemIndex + 1;
                cloned.splice(insertIndex, 0, buildSummarySystemMessage(storedSummary));
                state.updatePrompt(cloned);
                return {
                    reason: "stored-compaction-summary-injected",
                    payloads: {
                        storedSummary,
                    },
                };
            }
        }
        if (!hasPendingCompaction) {
            return {
                reason: "no-compaction-requested",
            };
        }
        const { systemMessages, summarizableMessages, preservedMessages, } = partitionPromptForSummarization(state.prompt, this.keepLastMessages, state.pinnedToolCallIds);
        if (summarizableMessages.length === 0) {
            this.pendingCompactionKeys.delete(requestKey);
            return {
                reason: "no-summarizable-messages",
                payloads: {
                    keepLastMessages: this.keepLastMessages,
                },
            };
        }
        const existingSummaryIndex = systemMessages.findIndex(isCompactionSummaryMessage);
        const existingSummary = existingSummaryIndex === -1 ? null : systemMessages[existingSummaryIndex];
        const messagesToSummarize = existingSummary
            ? [existingSummary, ...summarizableMessages]
            : summarizableMessages;
        const summaryText = await this.summarize(messagesToSummarize);
        const summaryMessage = buildSummarySystemMessage(summaryText);
        const nonSummarySystemMessages = systemMessages.filter((_, index) => index !== existingSummaryIndex);
        const nextPrompt = [
            ...nonSummarySystemMessages,
            summaryMessage,
            ...preservedMessages,
        ];
        const removedExchanges = computeRemovedToolExchanges(state.prompt, nextPrompt);
        state.addRemovedToolExchanges(removedExchanges);
        if (this.compactionStore) {
            const key = buildCompactionKey(state.requestContext);
            await this.compactionStore.set(key, summaryText);
        }
        state.updatePrompt(nextPrompt);
        this.pendingCompactionKeys.delete(requestKey);
        return {
            reason: "context-compacted",
            payloads: {
                keepLastMessages: this.keepLastMessages,
                messagesToSummarize,
                summaryText,
            },
        };
    }
}
