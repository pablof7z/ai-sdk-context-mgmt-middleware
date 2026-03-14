import type { LanguageModelV3CallOptions, LanguageModelV3Middleware, LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { appendReminderToLatestUserMessage, clonePrompt, extractRequestContext } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import { CONTEXT_MANAGEMENT_KEY } from "./types.js";
import type {
  ContextManagementModelRef,
  ContextManagementRequestContext,
  ContextManagementReminder,
  ContextManagementReminderSink,
  ContextManagementRuntime,
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  ContextManagementTelemetrySink,
  CreateContextManagementRuntimeOptions,
  PromptTokenEstimator,
  RemovedToolExchange,
} from "./types.js";

class StrategyState implements ContextManagementStrategyState {
  private currentParams: LanguageModelV3CallOptions;
  private readonly removedByToolCallId = new Map<string, RemovedToolExchange>();
  private readonly pinned = new Set<string>();

  constructor(
    params: LanguageModelV3CallOptions,
    public readonly requestContext: ContextManagementRequestContext,
    public readonly model?: ContextManagementModelRef,
    private readonly reminderSink?: ContextManagementReminderSink
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

  get pinnedToolCallIds(): ReadonlySet<string> {
    return this.pinned;
  }

  updatePrompt(prompt: LanguageModelV3CallOptions["prompt"]): void {
    this.currentParams = {
      ...this.currentParams,
      prompt,
    };
  }

  updateParams(patch: Partial<LanguageModelV3CallOptions>): void {
    this.currentParams = {
      ...this.currentParams,
      ...patch,
      prompt: patch.prompt ?? this.currentParams.prompt,
    };
  }

  addRemovedToolExchanges(exchanges: RemovedToolExchange[]): void {
    for (const exchange of exchanges) {
      this.removedByToolCallId.set(exchange.toolCallId, exchange);
    }
  }

  addPinnedToolCallIds(toolCallIds: string[]): void {
    for (const id of toolCallIds) {
      this.pinned.add(id);
    }
  }

  async emitReminder(reminder: ContextManagementReminder): Promise<void> {
    if (this.reminderSink) {
      await this.reminderSink.emit(reminder, this.requestContext);
      return;
    }

    this.updatePrompt(appendReminderToLatestUserMessage(this.prompt, reminder.content));
  }
}

function cloneUnknown<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }

  return value;
}

function promptsEqual(a: LanguageModelV3Prompt, b: LanguageModelV3Prompt): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function extractRequestContextFromExperimentalContext(
  experimentalContext: unknown
): ContextManagementRequestContext | null {
  if (
    !experimentalContext ||
    typeof experimentalContext !== "object" ||
    !(CONTEXT_MANAGEMENT_KEY in experimentalContext)
  ) {
    return null;
  }

  const raw = (experimentalContext as Record<string, unknown>)[CONTEXT_MANAGEMENT_KEY];
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const conversationId = (raw as Record<string, unknown>).conversationId;
  const agentId = (raw as Record<string, unknown>).agentId;
  const agentLabel = (raw as Record<string, unknown>).agentLabel;

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

async function emitTelemetry(
  telemetry: ContextManagementTelemetrySink | undefined,
  buildEvent: () => Parameters<ContextManagementTelemetrySink>[0]
): Promise<void> {
  if (!telemetry) {
    return;
  }

  try {
    await telemetry(buildEvent());
  } catch {
    // Telemetry is best-effort and must never break model or tool execution.
  }
}

function mergeOptionalTools(strategies: readonly ContextManagementStrategy[]): {
  tools: ToolSet;
  toolOwners: Map<string, string>;
} {
  const merged = {} as ToolSet;
  const toolOwners = new Map<string, string>();

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

function wrapOptionalTools(
  tools: ToolSet,
  toolOwners: Map<string, string>,
  telemetry: ContextManagementTelemetrySink | undefined
): ToolSet {
  const wrapped = {} as ToolSet;

  for (const [toolName, toolDefinition] of Object.entries(tools)) {
    const strategyName = toolOwners.get(toolName);
    const execute = (toolDefinition as { execute?: (...args: unknown[]) => unknown }).execute;

    if (!execute) {
      wrapped[toolName] = toolDefinition;
      continue;
    }

    wrapped[toolName] = {
      ...toolDefinition,
      execute: async (input: unknown, options: { toolCallId?: string; experimental_context?: unknown }) => {
        const requestContext = extractRequestContextFromExperimentalContext(options.experimental_context);
        await emitTelemetry(telemetry, () => ({
          type: "tool-execute-start",
          toolName,
          strategyName,
          toolCallId: options.toolCallId,
          requestContext,
          payloads: {
            input: cloneUnknown(input),
          },
        }));

        try {
          const result = await execute(input, options);
          await emitTelemetry(telemetry, () => ({
            type: "tool-execute-complete",
            toolName,
            strategyName,
            toolCallId: options.toolCallId,
            requestContext,
            payloads: {
              input: cloneUnknown(input),
              result: cloneUnknown(result),
            },
          }));
          return result;
        } catch (error) {
          await emitTelemetry(telemetry, () => ({
            type: "tool-execute-error",
            toolName,
            strategyName,
            toolCallId: options.toolCallId,
            requestContext,
            payloads: {
              input: cloneUnknown(input),
              error: cloneUnknown(error),
            },
          }));
          throw error;
        }
      },
    };
  }

  return wrapped;
}

export function createContextManagementRuntime(
  options: CreateContextManagementRuntimeOptions
): ContextManagementRuntime {
  const strategies = [...options.strategies];
  const estimator: PromptTokenEstimator = options.estimator ?? createDefaultPromptTokenEstimator();
  const { tools, toolOwners } = mergeOptionalTools(strategies);
  const optionalTools = wrapOptionalTools(tools, toolOwners, options.telemetry);
  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    async transformParams({ params, model }) {
      const requestContext = extractRequestContext(params);

      if (!requestContext) {
        return params;
      }

      const state = new StrategyState(params, requestContext, {
        provider: model.provider,
        modelId: model.modelId,
      }, options.reminderSink);
      const initialPrompt = clonePrompt(state.prompt);
      const toolTokenOverhead = estimator.estimateTools?.(params.tools) ?? 0;
      const estimate = (prompt: LanguageModelV3Prompt) =>
        estimator.estimatePrompt(prompt) + toolTokenOverhead;

      await emitTelemetry(options.telemetry, () => ({
        type: "runtime-start",
        requestContext,
        strategyNames: strategies.map((strategy) => strategy.name ?? "unnamed-strategy"),
        optionalToolNames: Object.keys(optionalTools),
        estimatedTokensBefore: estimate(initialPrompt),
        payloads: {
          prompt: initialPrompt,
          providerOptions: cloneUnknown(params.providerOptions),
        },
      }));

      for (const strategy of strategies) {
        const promptBefore = clonePrompt(state.prompt);
        const removedBefore = state.removedToolExchanges.length;
        const pinnedBefore = state.pinnedToolCallIds.size;
        const estimatedTokensBefore = estimate(promptBefore);
        const execution: ContextManagementStrategyExecution | void = await strategy.apply(state);
        const promptAfter = clonePrompt(state.prompt);
        const estimatedTokensAfter = estimate(promptAfter);
        const removedAfter = state.removedToolExchanges.length;
        const pinnedAfter = state.pinnedToolCallIds.size;
        const changed = !promptsEqual(promptBefore, promptAfter)
          || removedAfter !== removedBefore
          || pinnedAfter !== pinnedBefore;

        await emitTelemetry(options.telemetry, () => ({
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
        }));
      }

      await emitTelemetry(options.telemetry, () => ({
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
      }));

      return state.params;
    },
  };

  return {
    middleware,
    optionalTools,
  };
}
