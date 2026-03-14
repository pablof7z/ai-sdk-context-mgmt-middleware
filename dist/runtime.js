import { clonePrompt, extractRequestContext } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
class StrategyState {
    requestContext;
    currentParams;
    removedByToolCallId = new Map();
    pinned = new Set();
    constructor(params, requestContext) {
        this.requestContext = requestContext;
        this.currentParams = {
            ...params,
            prompt: clonePrompt(params.prompt),
        };
    }
    get params() {
        return this.currentParams;
    }
    get prompt() {
        return this.currentParams.prompt;
    }
    get removedToolExchanges() {
        return Array.from(this.removedByToolCallId.values());
    }
    get pinnedToolCallIds() {
        return this.pinned;
    }
    updatePrompt(prompt) {
        this.currentParams = {
            ...this.currentParams,
            prompt,
        };
    }
    updateParams(patch) {
        this.currentParams = {
            ...this.currentParams,
            ...patch,
            prompt: patch.prompt ?? this.currentParams.prompt,
        };
    }
    addRemovedToolExchanges(exchanges) {
        for (const exchange of exchanges) {
            this.removedByToolCallId.set(exchange.toolCallId, exchange);
        }
    }
    addPinnedToolCallIds(toolCallIds) {
        for (const id of toolCallIds) {
            this.pinned.add(id);
        }
    }
}
function cloneUnknown(value) {
    if (value === undefined || value === null) {
        return value;
    }
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return value;
}
function promptsEqual(a, b) {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    catch {
        return false;
    }
}
function extractRequestContextFromExperimentalContext(experimentalContext) {
    if (!experimentalContext ||
        typeof experimentalContext !== "object" ||
        !(CONTEXT_MANAGEMENT_KEY in experimentalContext)) {
        return null;
    }
    const raw = experimentalContext[CONTEXT_MANAGEMENT_KEY];
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const conversationId = raw.conversationId;
    const agentId = raw.agentId;
    const agentLabel = raw.agentLabel;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
        return null;
    }
    if (typeof agentId !== "string" || agentId.length === 0) {
        return null;
    }
    return {
        conversationId,
        agentId,
        ...(typeof agentLabel === "string" && agentLabel.length > 0 ? { agentLabel } : {}),
    };
}
async function emitTelemetry(telemetry, event) {
    if (!telemetry) {
        return;
    }
    await telemetry(event);
}
function mergeOptionalTools(strategies) {
    const merged = {};
    const toolOwners = new Map();
    for (const strategy of strategies) {
        const tools = strategy.getOptionalTools?.();
        if (!tools) {
            continue;
        }
        for (const [toolName, toolDefinition] of Object.entries(tools)) {
            if (toolName in merged) {
                throw new Error(`Duplicate context-management tool name: ${toolName}`);
            }
            merged[toolName] = toolDefinition;
            toolOwners.set(toolName, strategy.name ?? "unnamed-strategy");
        }
    }
    return {
        tools: merged,
        toolOwners,
    };
}
function wrapOptionalTools(tools, toolOwners, telemetry) {
    const wrapped = {};
    for (const [toolName, toolDefinition] of Object.entries(tools)) {
        const strategyName = toolOwners.get(toolName);
        const execute = toolDefinition.execute;
        if (!execute) {
            wrapped[toolName] = toolDefinition;
            continue;
        }
        wrapped[toolName] = {
            ...toolDefinition,
            execute: async (input, options) => {
                const requestContext = extractRequestContextFromExperimentalContext(options.experimental_context);
                await emitTelemetry(telemetry, {
                    type: "tool-execute-start",
                    toolName,
                    strategyName,
                    toolCallId: options.toolCallId,
                    requestContext,
                    payloads: {
                        input: cloneUnknown(input),
                    },
                });
                try {
                    const result = await execute(input, options);
                    await emitTelemetry(telemetry, {
                        type: "tool-execute-complete",
                        toolName,
                        strategyName,
                        toolCallId: options.toolCallId,
                        requestContext,
                        payloads: {
                            input: cloneUnknown(input),
                            result: cloneUnknown(result),
                        },
                    });
                    return result;
                }
                catch (error) {
                    await emitTelemetry(telemetry, {
                        type: "tool-execute-error",
                        toolName,
                        strategyName,
                        toolCallId: options.toolCallId,
                        requestContext,
                        payloads: {
                            input: cloneUnknown(input),
                            error: cloneUnknown(error),
                        },
                    });
                    throw error;
                }
            },
        };
    }
    return wrapped;
}
export function createContextManagementRuntime(options) {
    const strategies = [...options.strategies];
    const estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    const { tools, toolOwners } = mergeOptionalTools(strategies);
    const optionalTools = wrapOptionalTools(tools, toolOwners, options.telemetry);
    const middleware = {
        specificationVersion: "v3",
        async transformParams({ params }) {
            const requestContext = extractRequestContext(params);
            if (!requestContext) {
                return params;
            }
            const state = new StrategyState(params, requestContext);
            const initialPrompt = clonePrompt(state.prompt);
            const toolTokenOverhead = estimator.estimateTools?.(params.tools) ?? 0;
            const estimate = (prompt) => estimator.estimatePrompt(prompt) + toolTokenOverhead;
            await emitTelemetry(options.telemetry, {
                type: "runtime-start",
                requestContext,
                strategyNames: strategies.map((strategy) => strategy.name ?? "unnamed-strategy"),
                optionalToolNames: Object.keys(optionalTools),
                estimatedTokensBefore: estimate(initialPrompt),
                payloads: {
                    prompt: initialPrompt,
                    providerOptions: cloneUnknown(params.providerOptions),
                },
            });
            for (const strategy of strategies) {
                const promptBefore = clonePrompt(state.prompt);
                const removedBefore = state.removedToolExchanges.length;
                const pinnedBefore = state.pinnedToolCallIds.size;
                const estimatedTokensBefore = estimate(promptBefore);
                const execution = await strategy.apply(state);
                const promptAfter = clonePrompt(state.prompt);
                const estimatedTokensAfter = estimate(promptAfter);
                const removedAfter = state.removedToolExchanges.length;
                const pinnedAfter = state.pinnedToolCallIds.size;
                const changed = !promptsEqual(promptBefore, promptAfter)
                    || removedAfter !== removedBefore
                    || pinnedAfter !== pinnedBefore;
                await emitTelemetry(options.telemetry, {
                    type: "strategy-complete",
                    requestContext,
                    strategyName: strategy.name ?? "unnamed-strategy",
                    outcome: execution?.outcome ?? (changed ? "applied" : "skipped"),
                    reason: execution?.reason ?? (changed ? "state-changed" : "no-op"),
                    estimatedTokensBefore,
                    estimatedTokensAfter,
                    workingTokenBudget: execution?.workingTokenBudget,
                    removedToolExchangesDelta: removedAfter - removedBefore,
                    removedToolExchangesTotal: removedAfter,
                    pinnedToolCallIdsDelta: pinnedAfter - pinnedBefore,
                    payloads: {
                        promptBefore,
                        promptAfter,
                        ...(execution?.payloads ? { strategy: cloneUnknown(execution.payloads) } : {}),
                    },
                });
            }
            await emitTelemetry(options.telemetry, {
                type: "runtime-complete",
                requestContext,
                estimatedTokensBefore: estimate(initialPrompt),
                estimatedTokensAfter: estimate(state.prompt),
                removedToolExchangesTotal: state.removedToolExchanges.length,
                pinnedToolCallIdsTotal: state.pinnedToolCallIds.size,
                payloads: {
                    promptBefore: initialPrompt,
                    promptAfter: clonePrompt(state.prompt),
                },
            });
            return state.params;
        },
    };
    return {
        middleware,
        optionalTools,
    };
}
