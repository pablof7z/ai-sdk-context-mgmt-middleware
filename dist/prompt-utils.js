import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
function cloneUnknown(value) {
    if (value === undefined || value === null) {
        return value;
    }
    if (typeof structuredClone === "function") {
        try {
            return structuredClone(value);
        }
        catch {
            return value;
        }
    }
    return value;
}
function buildReminderSystemMessage(reminderText) {
    return {
        role: "system",
        content: reminderText,
        providerOptions: { contextManagement: { type: "reminder" } },
    };
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
export function isContextManagementSystemMessage(message) {
    if (message.role !== "system") {
        return false;
    }
    return isRecord(message.providerOptions?.contextManagement);
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
export function getPinnedMessageIndices(prompt, pinnedToolCallIds) {
    if (pinnedToolCallIds.size === 0) {
        return new Set();
    }
    const exchanges = collectToolExchanges(prompt);
    const pinnedMessageIndices = new Set();
    for (const toolCallId of pinnedToolCallIds) {
        const exchange = exchanges.get(toolCallId);
        if (!exchange) {
            continue;
        }
        if (exchange.callMessageIndex !== undefined) {
            pinnedMessageIndices.add(exchange.callMessageIndex);
        }
        for (const index of exchange.resultMessageIndices) {
            pinnedMessageIndices.add(index);
        }
    }
    return pinnedMessageIndices;
}
export function buildPromptFromSelectedIndices(prompt, selectedIndices) {
    const cloned = clonePrompt(prompt);
    return cloned.filter((message, index) => message.role === "system" || selectedIndices.has(index));
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
export function getLatestToolActivity(prompt) {
    for (let messageIndex = prompt.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = prompt[messageIndex];
        if (message.role === "system") {
            continue;
        }
        for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = message.content[partIndex];
            if (isToolResultPart(part)) {
                return {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    type: "tool-result",
                };
            }
            if (isToolCallPart(part)) {
                return {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    type: "tool-call",
                };
            }
        }
    }
    return null;
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
    const normalizedHeadCount = Math.max(0, Math.floor(options?.headCount ?? 0));
    const normalizedKeepLastMessages = Math.max(0, Math.floor(keepLastMessages));
    const nonSystemMessageCount = prompt.reduce((count, message) => count + (message.role === "system" ? 0 : 1), 0);
    const estimator = options?.estimator ?? createDefaultPromptTokenEstimator();
    const maxPromptTokens = options?.maxPromptTokens;
    if (normalizedHeadCount + normalizedKeepLastMessages >= nonSystemMessageCount &&
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
        const result = trimPromptHeadAndTail(prompt, normalizedHeadCount, keep, reason, { pinnedToolCallIds: options?.pinnedToolCallIds });
        bestResult = result;
        if (maxPromptTokens === undefined || estimator.estimatePrompt(result.prompt) <= maxPromptTokens) {
            return result;
        }
    }
    return bestResult;
}
export function trimPromptHeadAndTail(prompt, headCount, tailCount, reason, options) {
    const normalizedHead = Math.max(0, Math.floor(headCount));
    const normalizedTail = Math.max(0, Math.floor(tailCount));
    const nonSystemIndices = [];
    for (let i = 0; i < prompt.length; i++) {
        if (prompt[i].role !== "system") {
            nonSystemIndices.push(i);
        }
    }
    if (nonSystemIndices.length <= normalizedHead + normalizedTail) {
        return {
            prompt: clonePrompt(prompt),
            removedToolExchanges: [],
        };
    }
    const exchanges = collectToolExchanges(prompt);
    // Determine head boundary: first headCount non-system messages (exclusive index into nonSystemIndices)
    let headEndNonSystem = normalizedHead;
    // Expand head boundary forward to avoid splitting tool exchanges
    for (;;) {
        let expanded = false;
        for (const exchange of exchanges.values()) {
            if (exchange.callMessageIndex === undefined)
                continue;
            const callNsIdx = nonSystemIndices.indexOf(exchange.callMessageIndex);
            const resultNsIndices = exchange.resultMessageIndices
                .map((ri) => nonSystemIndices.indexOf(ri))
                .filter((i) => i !== -1);
            if (callNsIdx !== -1 && callNsIdx < headEndNonSystem) {
                for (const rni of resultNsIndices) {
                    if (rni >= headEndNonSystem && rni < nonSystemIndices.length - normalizedTail) {
                        headEndNonSystem = rni + 1;
                        expanded = true;
                    }
                }
            }
            for (const rni of resultNsIndices) {
                if (rni < headEndNonSystem && callNsIdx >= headEndNonSystem && callNsIdx < nonSystemIndices.length - normalizedTail) {
                    headEndNonSystem = callNsIdx + 1;
                    expanded = true;
                }
            }
        }
        if (!expanded)
            break;
    }
    // Determine tail boundary: last tailCount non-system messages (inclusive index into nonSystemIndices)
    let tailStartNonSystem = nonSystemIndices.length - normalizedTail;
    // Expand tail boundary backward to avoid splitting tool exchanges
    for (;;) {
        let expanded = false;
        for (const exchange of exchanges.values()) {
            if (exchange.callMessageIndex === undefined)
                continue;
            const callNsIdx = nonSystemIndices.indexOf(exchange.callMessageIndex);
            const resultNsIndices = exchange.resultMessageIndices
                .map((ri) => nonSystemIndices.indexOf(ri))
                .filter((i) => i !== -1);
            for (const rni of resultNsIndices) {
                if (rni >= tailStartNonSystem && callNsIdx !== -1 && callNsIdx < tailStartNonSystem && callNsIdx >= headEndNonSystem) {
                    tailStartNonSystem = callNsIdx;
                    expanded = true;
                }
            }
            if (callNsIdx !== -1 && callNsIdx >= tailStartNonSystem) {
                for (const rni of resultNsIndices) {
                    if (rni < tailStartNonSystem && rni >= headEndNonSystem) {
                        tailStartNonSystem = rni;
                        expanded = true;
                    }
                }
            }
        }
        if (!expanded)
            break;
    }
    // If boundaries overlap or meet, nothing to drop
    if (headEndNonSystem >= tailStartNonSystem) {
        return {
            prompt: clonePrompt(prompt),
            removedToolExchanges: [],
        };
    }
    const keptIndices = getPinnedMessageIndices(prompt, options?.pinnedToolCallIds ?? new Set());
    for (let i = 0; i < headEndNonSystem; i++) {
        keptIndices.add(nonSystemIndices[i]);
    }
    for (let i = tailStartNonSystem; i < nonSystemIndices.length; i++) {
        keptIndices.add(nonSystemIndices[i]);
    }
    const nextPrompt = buildPromptFromSelectedIndices(prompt, keptIndices);
    // Build removed tool exchanges
    const nextExchanges = collectToolExchanges(nextPrompt);
    const removedToolExchanges = [];
    for (const exchange of exchanges.values()) {
        if (!nextExchanges.has(exchange.toolCallId)) {
            removedToolExchanges.push({
                toolCallId: exchange.toolCallId,
                toolName: exchange.toolName,
                reason,
            });
        }
    }
    return {
        prompt: nextPrompt,
        removedToolExchanges,
    };
}
export function trimPromptHeadAndTailAroundAnchor(prompt, headCount, tailCount, anchorToolCallId, reason, options) {
    const normalizedHead = Math.max(0, Math.floor(headCount));
    const normalizedTail = Math.max(0, Math.floor(tailCount));
    const exchanges = collectToolExchanges(prompt);
    const anchorExchange = exchanges.get(anchorToolCallId);
    const anchorStartIndex = anchorExchange?.callMessageIndex
        ?? anchorExchange?.resultMessageIndices.reduce((min, index) => Math.min(min, index), Number.POSITIVE_INFINITY);
    if (anchorStartIndex === undefined || !Number.isFinite(anchorStartIndex)) {
        return {
            prompt: clonePrompt(prompt),
            removedToolExchanges: [],
        };
    }
    const preAnchorNonSystemIndices = [];
    for (let index = 0; index < anchorStartIndex; index += 1) {
        if (prompt[index].role !== "system") {
            preAnchorNonSystemIndices.push(index);
        }
    }
    if (preAnchorNonSystemIndices.length <= normalizedHead + normalizedTail) {
        return {
            prompt: clonePrompt(prompt),
            removedToolExchanges: [],
        };
    }
    const keptIndices = getPinnedMessageIndices(prompt, options?.pinnedToolCallIds ?? new Set());
    const headLimit = Math.min(normalizedHead, preAnchorNonSystemIndices.length);
    const tailStart = Math.max(headLimit, preAnchorNonSystemIndices.length - normalizedTail);
    for (let index = 0; index < headLimit; index += 1) {
        keptIndices.add(preAnchorNonSystemIndices[index]);
    }
    for (let index = tailStart; index < preAnchorNonSystemIndices.length; index += 1) {
        keptIndices.add(preAnchorNonSystemIndices[index]);
    }
    for (let index = anchorStartIndex; index < prompt.length; index += 1) {
        if (prompt[index].role !== "system") {
            keptIndices.add(index);
        }
    }
    for (;;) {
        let expanded = false;
        for (const exchange of exchanges.values()) {
            const exchangeIndices = [
                ...(exchange.callMessageIndex !== undefined ? [exchange.callMessageIndex] : []),
                ...exchange.resultMessageIndices,
            ];
            if (exchangeIndices.length === 0) {
                continue;
            }
            const shouldKeepWholeExchange = exchangeIndices.some((index) => keptIndices.has(index));
            if (!shouldKeepWholeExchange) {
                continue;
            }
            for (const index of exchangeIndices) {
                if (!keptIndices.has(index)) {
                    keptIndices.add(index);
                    expanded = true;
                }
            }
        }
        if (!expanded) {
            break;
        }
    }
    const nextPrompt = buildPromptFromSelectedIndices(prompt, keptIndices);
    return {
        prompt: nextPrompt,
        removedToolExchanges: buildRemovedToolExchanges(prompt, nextPrompt, reason),
    };
}
export function partitionPromptForSummarization(prompt, keepLastMessages, pinnedToolCallIds) {
    const normalizedKeepLastMessages = Math.max(0, Math.floor(keepLastMessages));
    const tailStartIndex = computeTailStartIndex(prompt, normalizedKeepLastMessages);
    const pinnedMessageIndices = getPinnedMessageIndices(prompt, pinnedToolCallIds ?? new Set());
    const preservedNonSystemIndices = new Set(pinnedMessageIndices);
    for (let index = tailStartIndex; index < prompt.length; index++) {
        if (prompt[index].role !== "system") {
            preservedNonSystemIndices.add(index);
        }
    }
    const cloned = clonePrompt(prompt);
    const systemMessages = [];
    const summarizableMessages = [];
    const preservedMessages = [];
    for (const [index, message] of cloned.entries()) {
        if (message.role === "system") {
            systemMessages.push(message);
            continue;
        }
        if (preservedNonSystemIndices.has(index)) {
            preservedMessages.push(message);
            continue;
        }
        summarizableMessages.push(message);
    }
    return {
        systemMessages,
        summarizableMessages,
        preservedMessages,
    };
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
    const insertIndex = cloned.reduce((lastIndex, message, index) => (message.role === "system" ? index : lastIndex), -1) + 1;
    cloned.splice(insertIndex, 0, buildReminderSystemMessage(reminderText));
    return cloned;
}
