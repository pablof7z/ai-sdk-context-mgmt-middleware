import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
function cloneUnknown(value) {
    if (value === undefined || value === null) {
        return value;
    }
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return value;
}
function cloneMessage(message) {
    if (message.role === "system") {
        return {
            ...message,
            providerOptions: cloneUnknown(message.providerOptions),
        };
    }
    if (message.role === "user") {
        return {
            ...message,
            providerOptions: cloneUnknown(message.providerOptions),
            content: message.content.map((part) => ({
                ...part,
                providerOptions: cloneUnknown(part.providerOptions),
            })),
        };
    }
    if (message.role === "assistant") {
        return {
            ...message,
            providerOptions: cloneUnknown(message.providerOptions),
            content: message.content.map((part) => {
                switch (part.type) {
                    case "tool-call":
                        return {
                            ...part,
                            input: cloneUnknown(part.input),
                            providerOptions: cloneUnknown(part.providerOptions),
                        };
                    case "tool-result":
                        return {
                            ...part,
                            output: cloneUnknown(part.output),
                            providerOptions: cloneUnknown(part.providerOptions),
                        };
                    default:
                        return {
                            ...part,
                            providerOptions: cloneUnknown(part.providerOptions),
                        };
                }
            }),
        };
    }
    return {
        ...message,
        providerOptions: cloneUnknown(message.providerOptions),
        content: message.content.map((part) => {
            if (part.type === "tool-result") {
                return {
                    ...part,
                    output: cloneUnknown(part.output),
                    providerOptions: cloneUnknown(part.providerOptions),
                };
            }
            return {
                ...part,
                providerOptions: cloneUnknown(part.providerOptions),
            };
        }),
    };
}
function isToolCallPart(part) {
    return typeof part === "object" && part !== null && part.type === "tool-call";
}
function isToolResultPart(part) {
    return typeof part === "object" && part !== null && part.type === "tool-result";
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function buildRemovedToolExchanges(originalPrompt, nextPrompt, reason) {
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
            reason,
        });
    }
    return removed;
}
function computeTailStartIndex(prompt, keepLastMessages) {
    const nonSystemIndices = prompt.flatMap((message, index) => message.role === "system" ? [] : [index]);
    if (nonSystemIndices.length === 0) {
        return prompt.length;
    }
    if (keepLastMessages <= 0) {
        return prompt.length;
    }
    if (keepLastMessages >= nonSystemIndices.length) {
        return 0;
    }
    let startIndex = nonSystemIndices[nonSystemIndices.length - keepLastMessages];
    const exchanges = collectToolExchanges(prompt);
    for (;;) {
        let nextStartIndex = startIndex;
        for (const exchange of exchanges.values()) {
            const hasKeptResult = exchange.resultMessageIndices.some((messageIndex) => messageIndex >= startIndex);
            if (!hasKeptResult || exchange.callMessageIndex === undefined) {
                continue;
            }
            if (exchange.callMessageIndex < nextStartIndex) {
                nextStartIndex = exchange.callMessageIndex;
            }
        }
        if (nextStartIndex === startIndex) {
            return startIndex;
        }
        startIndex = nextStartIndex;
    }
}
function buildPromptFromTail(prompt, startIndex) {
    const cloned = clonePrompt(prompt);
    return cloned.filter((message, index) => message.role === "system" || index >= startIndex);
}
export function clonePrompt(prompt) {
    return prompt.map((message) => cloneMessage(message));
}
export function extractRequestContext(params) {
    const rawContext = params.providerOptions?.[CONTEXT_MANAGEMENT_KEY];
    if (!isRecord(rawContext)) {
        return null;
    }
    const conversationId = rawContext.conversationId;
    const agentId = rawContext.agentId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
        return null;
    }
    if (typeof agentId !== "string" || agentId.length === 0) {
        return null;
    }
    return {
        conversationId,
        agentId,
        ...(typeof rawContext.agentLabel === "string" && rawContext.agentLabel.length > 0
            ? { agentLabel: rawContext.agentLabel }
            : {}),
    };
}
export function collectToolExchanges(prompt) {
    const exchanges = new Map();
    for (const [messageIndex, message] of prompt.entries()) {
        if (message.role === "system") {
            continue;
        }
        for (const part of message.content) {
            if (isToolCallPart(part)) {
                const existing = exchanges.get(part.toolCallId) ?? {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    resultMessageIndices: [],
                };
                existing.toolName = part.toolName;
                existing.callMessageIndex = existing.callMessageIndex ?? messageIndex;
                exchanges.set(part.toolCallId, existing);
                continue;
            }
            if (isToolResultPart(part)) {
                const existing = exchanges.get(part.toolCallId) ?? {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    resultMessageIndices: [],
                };
                existing.toolName = part.toolName;
                existing.resultMessageIndices.push(messageIndex);
                exchanges.set(part.toolCallId, existing);
            }
        }
    }
    return exchanges;
}
export function removeToolExchanges(prompt, toolCallIds, reason) {
    if (toolCallIds.length === 0) {
        return {
            prompt: clonePrompt(prompt),
            removedToolExchanges: [],
        };
    }
    const idsToRemove = new Set(toolCallIds);
    const cloned = clonePrompt(prompt);
    const nextPrompt = [];
    for (const message of cloned) {
        if (message.role === "system") {
            nextPrompt.push(message);
            continue;
        }
        if (message.role === "user") {
            nextPrompt.push(message);
            continue;
        }
        const filteredContent = message.content.filter((part) => {
            if (isToolCallPart(part) || isToolResultPart(part)) {
                return !idsToRemove.has(part.toolCallId);
            }
            return true;
        });
        if (filteredContent.length === 0) {
            continue;
        }
        if (message.role === "assistant") {
            nextPrompt.push({
                ...message,
                content: filteredContent,
            });
            continue;
        }
        nextPrompt.push({
            ...message,
            content: filteredContent,
        });
    }
    return {
        prompt: nextPrompt,
        removedToolExchanges: buildRemovedToolExchanges(prompt, nextPrompt, reason),
    };
}
export function trimPromptToLastMessages(prompt, keepLastMessages, reason, options) {
    const normalizedKeepLastMessages = Math.max(0, Math.floor(keepLastMessages));
    const nonSystemMessageCount = prompt.reduce((count, message) => count + (message.role === "system" ? 0 : 1), 0);
    const estimator = options?.estimator ?? createDefaultPromptTokenEstimator();
    const maxPromptTokens = options?.maxPromptTokens;
    if (normalizedKeepLastMessages >= nonSystemMessageCount &&
        (maxPromptTokens === undefined || estimator.estimatePrompt(prompt) <= maxPromptTokens)) {
        return {
            prompt: clonePrompt(prompt),
            removedToolExchanges: [],
        };
    }
    let bestResult = {
        prompt: clonePrompt(prompt),
        removedToolExchanges: [],
    };
    for (let keep = Math.min(normalizedKeepLastMessages, nonSystemMessageCount); keep >= 0; keep--) {
        const startIndex = computeTailStartIndex(prompt, keep);
        const nextPrompt = buildPromptFromTail(prompt, startIndex);
        const result = {
            prompt: nextPrompt,
            removedToolExchanges: buildRemovedToolExchanges(prompt, nextPrompt, reason),
        };
        bestResult = result;
        if (maxPromptTokens === undefined || estimator.estimatePrompt(nextPrompt) <= maxPromptTokens) {
            return result;
        }
    }
    return bestResult;
}
export function appendReminderToLatestUserMessage(prompt, reminderText) {
    const cloned = clonePrompt(prompt);
    for (let index = cloned.length - 1; index >= 0; index--) {
        const message = cloned[index];
        if (message.role !== "user") {
            continue;
        }
        cloned[index] = {
            ...message,
            content: [
                ...message.content,
                { type: "text", text: reminderText },
            ],
        };
        return cloned;
    }
    return [
        ...cloned,
        {
            role: "user",
            content: [{ type: "text", text: reminderText }],
        },
    ];
}
