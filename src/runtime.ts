import type { LanguageModelV3CallOptions, LanguageModelV3Middleware } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { clonePrompt, extractRequestContext } from "./prompt-utils.js";
import type {
  ContextManagementRequestContext,
  ContextManagementRuntime,
  ContextManagementStrategy,
  ContextManagementStrategyState,
  CreateContextManagementRuntimeOptions,
  RemovedToolExchange,
} from "./types.js";

class StrategyState implements ContextManagementStrategyState {
  private currentParams: LanguageModelV3CallOptions;
  private readonly removedByToolCallId = new Map<string, RemovedToolExchange>();

  constructor(
    params: LanguageModelV3CallOptions,
    public readonly requestContext: ContextManagementRequestContext
  ) {
    this.currentParams = {
      ...params,
      prompt: clonePrompt(params.prompt),
    };
  }

  get params(): LanguageModelV3CallOptions {
    return this.currentParams;
  }

  get prompt() {
    return this.currentParams.prompt;
  }

  get removedToolExchanges(): readonly RemovedToolExchange[] {
    return Array.from(this.removedByToolCallId.values());
  }

  updatePrompt(prompt: LanguageModelV3CallOptions["prompt"]): void {
    this.currentParams = {
      ...this.currentParams,
      prompt,
    };
  }

  addRemovedToolExchanges(exchanges: RemovedToolExchange[]): void {
    for (const exchange of exchanges) {
      this.removedByToolCallId.set(exchange.toolCallId, exchange);
    }
  }
}

function mergeOptionalTools(strategies: readonly ContextManagementStrategy[]): ToolSet {
  const merged = {} as ToolSet;

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

export function createContextManagementRuntime(
  options: CreateContextManagementRuntimeOptions
): ContextManagementRuntime {
  const strategies = [...options.strategies];
  const optionalTools = mergeOptionalTools(strategies);
  const middleware: LanguageModelV3Middleware = {
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
