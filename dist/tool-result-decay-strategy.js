import { clonePrompt, collectToolExchanges } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
const DEFAULT_TRUNCATED_MAX_TOKENS = 200;
const DEFAULT_PLACEHOLDER_FLOOR_TOKENS = 20;
const DEFAULT_PLACEHOLDER = "[result omitted]";
const CHARS_PER_TOKEN = 4;
function safeStringify(value) {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value) ?? "";
    }
    catch {
        return String(value);
    }
}
function flattenContentToText(parts) {
    const segments = [];
    for (const part of parts) {
        switch (part.type) {
            case "text":
                segments.push(part.text);
                break;
            case "file-data":
                segments.push(`[file: ${part.mediaType}${part.filename ? `, ${part.filename}` : ""}]`);
                break;
            case "image-data":
                segments.push(`[image: ${part.mediaType}]`);
                break;
            case "file-url":
            case "image-url":
                segments.push(`[file: ${part.url}]`);
                break;
            case "file-id":
            case "image-file-id":
                segments.push("[file-ref]");
                break;
            case "custom":
                segments.push("[custom content]");
                break;
        }
    }
    return segments.join("\n");
}
export function estimateOutputChars(output) {
    switch (output.type) {
        case "text":
        case "error-text":
            return output.value.length;
        case "json":
        case "error-json":
            return safeStringify(output.value).length;
        case "content":
            return output.value.reduce((total, part) => {
                switch (part.type) {
                    case "text":
                        return total + part.text.length;
                    case "file-data":
                        return total + (part.data?.length ?? 0);
                    case "image-data":
                        return total + (part.data?.length ?? 0);
                    default:
                        return total + 50;
                }
            }, 0);
        case "execution-denied":
            return (output.reason ?? "").length;
        default:
            return 0;
    }
}
function truncateToolResultOutput(output, maxChars) {
    switch (output.type) {
        case "text":
        case "error-text":
            return output.value.length <= maxChars
                ? output
                : { type: "text", value: output.value.slice(0, maxChars) };
        case "json":
        case "error-json": {
            const serialized = safeStringify(output.value);
            return serialized.length <= maxChars
                ? output
                : { type: "text", value: serialized.slice(0, maxChars) };
        }
        case "content": {
            const flattened = flattenContentToText(output.value);
            return flattened.length <= maxChars
                ? { type: "text", value: flattened }
                : { type: "text", value: flattened.slice(0, maxChars) };
        }
        case "execution-denied":
            return output;
        default:
            return output;
    }
}
function serializeOutputToText(output) {
    switch (output.type) {
        case "text":
        case "error-text":
            return output.value;
        case "json":
        case "error-json":
            return safeStringify(output.value);
        case "content":
            return flattenContentToText(output.value);
        case "execution-denied":
            return output.reason ? `[execution denied: ${output.reason}]` : "[execution denied]";
        default:
            return safeStringify(output);
    }
}
function classifyExchange(depth, estimatedChars, baseMaxChars, placeholderFloorChars) {
    if (depth === 0) {
        return { type: "full" };
    }
    const maxChars = Math.floor(baseMaxChars / depth);
    if (maxChars < placeholderFloorChars) {
        return { type: "placeholder" };
    }
    if (estimatedChars > maxChars) {
        return { type: "truncate", maxChars };
    }
    return { type: "full" };
}
export class ToolResultDecayStrategy {
    name = "tool-result-decay";
    truncatedMaxTokens;
    placeholderFloorTokens;
    maxPromptTokens;
    placeholder;
    decayInputs;
    estimator;
    constructor(options = {}) {
        this.truncatedMaxTokens = Math.max(0, Math.floor(options.truncatedMaxTokens ?? DEFAULT_TRUNCATED_MAX_TOKENS));
        this.placeholderFloorTokens = Math.max(0, Math.floor(options.placeholderFloorTokens ?? DEFAULT_PLACEHOLDER_FLOOR_TOKENS));
        this.maxPromptTokens = options.maxPromptTokens;
        this.placeholder = options.placeholder ?? DEFAULT_PLACEHOLDER;
        this.decayInputs = options.decayInputs ?? true;
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    }
    async apply(state) {
        const currentPromptTokens = this.estimator.estimatePrompt(state.prompt)
            + (this.estimator.estimateTools?.(state.params?.tools) ?? 0);
        if (this.maxPromptTokens !== undefined &&
            currentPromptTokens <= this.maxPromptTokens) {
            return {
                reason: "below-token-threshold",
                workingTokenBudget: this.maxPromptTokens,
                payloads: {
                    currentPromptTokens,
                    truncatedMaxTokens: this.truncatedMaxTokens,
                    placeholderFloorTokens: this.placeholderFloorTokens,
                },
            };
        }
        const exchanges = collectToolExchanges(state.prompt);
        if (exchanges.size === 0) {
            return {
                reason: "no-tool-exchanges",
                workingTokenBudget: this.maxPromptTokens,
                payloads: {
                    currentPromptTokens,
                    truncatedMaxTokens: this.truncatedMaxTokens,
                    placeholderFloorTokens: this.placeholderFloorTokens,
                },
            };
        }
        // Group exchanges by their call message index so that all tool calls issued
        // in the same assistant turn (same batch) share the same depth.  This
        // prevents a large parallel batch from being immediately decayed because
        // individual calls within the batch get different positional depths.
        const turnGroups = new Map();
        for (const exchange of exchanges.values()) {
            const turnKey = exchange.callMessageIndex ?? -1;
            const group = turnGroups.get(turnKey) ?? [];
            group.push(exchange);
            turnGroups.set(turnKey, group);
        }
        // Sort groups oldest-first by call message index.
        const sortedGroups = [...turnGroups.entries()].sort(([a], [b]) => a - b);
        // Assign depth per group: depth 0 = most recent group.
        // Every call within the same batch gets the same depth.
        const depthMap = new Map();
        const numGroups = sortedGroups.length;
        for (let groupIdx = 0; groupIdx < numGroups; groupIdx++) {
            const depth = numGroups - 1 - groupIdx;
            for (const exchange of sortedGroups[groupIdx][1]) {
                depthMap.set(exchange.toolCallId, depth);
            }
        }
        // Flatten groups into a single list for the loops below.
        const sorted = sortedGroups.flatMap(([, group]) => group);
        const baseMaxChars = this.truncatedMaxTokens * CHARS_PER_TOKEN;
        const placeholderFloorChars = this.placeholderFloorTokens * CHARS_PER_TOKEN;
        // Build per-exchange estimated char counts and snapshot original outputs/inputs
        const charEstimates = new Map();
        const originalOutputs = new Map();
        const inputs = new Map();
        const inputCharEstimates = new Map();
        for (const message of state.prompt) {
            if (message.role !== "tool" && message.role !== "assistant") {
                continue;
            }
            for (const part of message.content) {
                if (part.type === "tool-result" && !charEstimates.has(part.toolCallId)) {
                    charEstimates.set(part.toolCallId, estimateOutputChars(part.output));
                    originalOutputs.set(part.toolCallId, part.output);
                }
                if (part.type === "tool-call" && !inputs.has(part.toolCallId)) {
                    inputs.set(part.toolCallId, part.input);
                    inputCharEstimates.set(part.toolCallId, safeStringify(part.input).length);
                }
            }
        }
        // Classify each exchange (outputs)
        const actions = new Map();
        for (const exchange of sorted) {
            if (state.pinnedToolCallIds.has(exchange.toolCallId)) {
                actions.set(exchange.toolCallId, { type: "full" });
                continue;
            }
            const depth = depthMap.get(exchange.toolCallId);
            const estimatedChars = charEstimates.get(exchange.toolCallId) ?? 0;
            actions.set(exchange.toolCallId, classifyExchange(depth, estimatedChars, baseMaxChars, placeholderFloorChars));
        }
        // Classify inputs independently
        const inputActions = new Map();
        if (this.decayInputs) {
            for (const exchange of sorted) {
                if (state.pinnedToolCallIds.has(exchange.toolCallId)) {
                    inputActions.set(exchange.toolCallId, { type: "full" });
                    continue;
                }
                const depth = depthMap.get(exchange.toolCallId);
                const estimatedChars = inputCharEstimates.get(exchange.toolCallId) ?? 0;
                inputActions.set(exchange.toolCallId, classifyExchange(depth, estimatedChars, baseMaxChars, placeholderFloorChars));
            }
        }
        // Find at-risk exchanges: currently full/lightly-truncated but will be significantly compressed next turn
        const atRiskExchanges = [];
        for (const exchange of sorted) {
            if (state.pinnedToolCallIds.has(exchange.toolCallId)) {
                continue;
            }
            const depth = depthMap.get(exchange.toolCallId);
            const estimatedChars = charEstimates.get(exchange.toolCallId) ?? 0;
            const currentAction = actions.get(exchange.toolCallId);
            const nextAction = classifyExchange(depth + 1, estimatedChars, baseMaxChars, placeholderFloorChars);
            // Only warn about big results that will be newly compressed
            if (estimatedChars <= baseMaxChars) {
                continue;
            }
            const isCurrentlyFull = currentAction.type === "full";
            const isCurrentlyLightlyTruncated = currentAction.type === "truncate" && currentAction.maxChars >= estimatedChars * 0.5;
            if (!isCurrentlyFull && !isCurrentlyLightlyTruncated) {
                continue;
            }
            const willBeNewlyCompressed = (nextAction.type === "truncate" && (isCurrentlyFull || (currentAction.type === "truncate" && nextAction.maxChars < currentAction.maxChars * 0.5))) ||
                nextAction.type === "placeholder";
            if (willBeNewlyCompressed) {
                atRiskExchanges.push({
                    toolCallId: exchange.toolCallId,
                    toolName: exchange.toolName,
                    input: inputs.get(exchange.toolCallId),
                    output: originalOutputs.get(exchange.toolCallId) ?? { type: "text", value: "" },
                    estimatedChars,
                    nextAction,
                });
            }
        }
        // Count truncated and placeholder exchanges (outputs)
        let truncatedCount = 0;
        let placeholderCount = 0;
        for (const action of actions.values()) {
            if (action.type === "truncate")
                truncatedCount++;
            if (action.type === "placeholder")
                placeholderCount++;
        }
        // Count truncated and placeholder inputs
        let inputTruncatedCount = 0;
        let inputPlaceholderCount = 0;
        if (this.decayInputs) {
            for (const action of inputActions.values()) {
                if (action.type === "truncate")
                    inputTruncatedCount++;
                if (action.type === "placeholder")
                    inputPlaceholderCount++;
            }
        }
        const hasMutations = truncatedCount > 0 || placeholderCount > 0
            || inputTruncatedCount > 0 || inputPlaceholderCount > 0;
        if (!hasMutations) {
            // Emit warning even if nothing to mutate this turn
            if (atRiskExchanges.length > 0) {
                await this.emitDecayWarning(state, atRiskExchanges);
            }
            return {
                reason: "tool-results-decayed",
                workingTokenBudget: this.maxPromptTokens,
                payloads: {
                    currentPromptTokens,
                    truncatedMaxTokens: this.truncatedMaxTokens,
                    placeholderFloorTokens: this.placeholderFloorTokens,
                    truncatedCount: 0,
                    placeholderCount: 0,
                    inputTruncatedCount: 0,
                    inputPlaceholderCount: 0,
                    totalToolExchanges: exchanges.size,
                    warningCount: atRiskExchanges.length,
                },
            };
        }
        // Emit warning before mutation
        if (atRiskExchanges.length > 0) {
            await this.emitDecayWarning(state, atRiskExchanges);
        }
        const prompt = clonePrompt(state.prompt);
        const removedExchanges = [];
        for (const message of prompt) {
            if (message.role !== "tool" && message.role !== "assistant") {
                continue;
            }
            for (const part of message.content) {
                // Decay tool-result outputs
                if (part.type === "tool-result") {
                    const action = actions.get(part.toolCallId);
                    if (!action || action.type === "full") {
                        continue;
                    }
                    if (action.type === "truncate") {
                        if (typeof this.placeholder === "function") {
                            const header = this.placeholder({
                                toolName: part.toolName,
                                toolCallId: part.toolCallId,
                                input: inputs.get(part.toolCallId),
                                output: originalOutputs.get(part.toolCallId),
                                action: "truncate",
                            });
                            const headerChars = header.length;
                            const contentBudget = Math.max(0, action.maxChars - headerChars);
                            const truncated = truncateToolResultOutput(part.output, contentBudget);
                            const truncatedValue = serializeOutputToText(truncated);
                            part.output = { type: "text", value: header + truncatedValue };
                        }
                        else {
                            part.output = truncateToolResultOutput(part.output, action.maxChars);
                        }
                    }
                    else if (action.type === "placeholder") {
                        const placeholderText = typeof this.placeholder === "function"
                            ? this.placeholder({
                                toolName: part.toolName,
                                toolCallId: part.toolCallId,
                                input: inputs.get(part.toolCallId),
                                output: originalOutputs.get(part.toolCallId),
                                action: "placeholder",
                            })
                            : this.placeholder;
                        part.output = { type: "text", value: placeholderText };
                        removedExchanges.push({
                            toolCallId: part.toolCallId,
                            toolName: part.toolName,
                            reason: "tool-result-decay",
                        });
                    }
                }
                // Decay tool-call inputs
                if (part.type === "tool-call" && this.decayInputs) {
                    const action = inputActions.get(part.toolCallId);
                    if (!action || action.type === "full") {
                        continue;
                    }
                    if (action.type === "truncate") {
                        const serialized = safeStringify(part.input);
                        part.input = { _truncated: serialized.slice(0, action.maxChars) };
                    }
                    else if (action.type === "placeholder") {
                        part.input = { _omitted: true };
                    }
                }
            }
        }
        state.updatePrompt(prompt);
        state.addRemovedToolExchanges(removedExchanges);
        return {
            reason: "tool-results-decayed",
            workingTokenBudget: this.maxPromptTokens,
            payloads: {
                currentPromptTokens,
                truncatedMaxTokens: this.truncatedMaxTokens,
                placeholderFloorTokens: this.placeholderFloorTokens,
                truncatedCount,
                placeholderCount,
                inputTruncatedCount,
                inputPlaceholderCount,
                totalToolExchanges: exchanges.size,
                warningCount: atRiskExchanges.length,
            },
        };
    }
    async emitDecayWarning(state, atRisk) {
        const lines = [
            "Context decay notice: The following tool results will be compressed next turn.",
            "Save any important information to your scratchpad now.",
        ];
        for (const entry of atRisk) {
            const estimatedTokens = Math.ceil(entry.estimatedChars / CHARS_PER_TOKEN);
            if (typeof this.placeholder === "function") {
                const formattedAction = entry.nextAction.type === "placeholder" ? "placeholder" : "truncate";
                const formatted = this.placeholder({
                    toolName: entry.toolName,
                    toolCallId: entry.toolCallId,
                    input: entry.input,
                    output: entry.output,
                    action: formattedAction,
                });
                lines.push(`- ${formatted} (~${estimatedTokens.toLocaleString("en-US")} tokens)`);
            }
            else if (entry.nextAction.type === "placeholder") {
                lines.push(`- ${entry.toolCallId} (${entry.toolName}): ~${estimatedTokens.toLocaleString("en-US")} tokens → replaced with placeholder`);
            }
            else if (entry.nextAction.type === "truncate") {
                lines.push(`- ${entry.toolCallId} (${entry.toolName}): ~${estimatedTokens.toLocaleString("en-US")} tokens → truncated to ~${entry.nextAction.maxChars.toLocaleString("en-US")} chars`);
            }
        }
        await state.emitReminder({
            kind: "tool-result-decay-warning",
            content: lines.join("\n"),
        });
    }
}
