import { clonePrompt, extractRequestContext } from "./prompt-utils.js";
class StrategyState {
    requestContext;
    currentParams;
    removedByToolCallId = new Map();
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
    updatePrompt(prompt) {
        this.currentParams = {
            ...this.currentParams,
            prompt,
        };
    }
    addRemovedToolExchanges(exchanges) {
        for (const exchange of exchanges) {
            this.removedByToolCallId.set(exchange.toolCallId, exchange);
        }
    }
}
function mergeOptionalTools(strategies) {
    const merged = {};
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
        }
    }
    return merged;
}
export function createContextManagementRuntime(options) {
    const strategies = [...options.strategies];
    const optionalTools = mergeOptionalTools(strategies);
    const middleware = {
        specificationVersion: "v3",
        async transformParams({ params }) {
            const requestContext = extractRequestContext(params);
            if (!requestContext) {
                return params;
            }
            const state = new StrategyState(params, requestContext);
            for (const strategy of strategies) {
                await strategy.apply(state);
            }
            return state.params;
        },
    };
    return {
        middleware,
        optionalTools,
    };
}
