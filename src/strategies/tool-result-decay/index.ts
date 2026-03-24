import type { LanguageModelV3ToolResultOutput } from "@ai-sdk/provider";
import { clonePrompt, collectToolExchanges, type ToolExchange } from "../../prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "../../token-estimator.js";
import type {
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  DecayedToolContext,
  RemovedToolExchange,
  ToolResultDecayPressureAnchor,
  ToolResultDecayStrategyOptions,
} from "../../types.js";

const DEFAULT_TRUNCATED_MAX_TOKENS = 200;
const DEFAULT_PLACEHOLDER_FLOOR_TOKENS = 20;
const DEFAULT_PLACEHOLDER = "[result omitted]";
const DEFAULT_WARNING_FORECAST_EXTRA_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const DEFAULT_PRESSURE_ANCHORS: readonly ToolResultDecayPressureAnchor[] = [
  { toolTokens: 100, depthFactor: 0.05 },
  { toolTokens: 5_000, depthFactor: 1 },
  { toolTokens: 50_000, depthFactor: 5 },
];

type DecayAction =
  | { type: "full" }
  | { type: "truncate"; maxChars: number }
  | { type: "placeholder" };

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function flattenContentToText(
  parts: Extract<LanguageModelV3ToolResultOutput, { type: "content" }>["value"]
): string {
  const segments: string[] = [];

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

export function estimateOutputChars(output: LanguageModelV3ToolResultOutput): number {
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

function truncateToolResultOutput(
  output: LanguageModelV3ToolResultOutput,
  maxChars: number
): LanguageModelV3ToolResultOutput {
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

function serializeOutputToText(output: LanguageModelV3ToolResultOutput): string {
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

function normalizePressureAnchors(
  anchors?: ToolResultDecayPressureAnchor[]
): ToolResultDecayPressureAnchor[] {
  const source = anchors?.length ? anchors : DEFAULT_PRESSURE_ANCHORS;
  const byToolTokens = new Map<number, number>();

  for (const anchor of source) {
    const toolTokens = Number.isFinite(anchor.toolTokens) ? Math.max(1, Math.floor(anchor.toolTokens)) : 1;
    const depthFactor = Number.isFinite(anchor.depthFactor) ? Math.max(0.0001, anchor.depthFactor) : 0.0001;
    byToolTokens.set(toolTokens, depthFactor);
  }

  if (byToolTokens.size === 0) {
    return DEFAULT_PRESSURE_ANCHORS.map((anchor) => ({ ...anchor }));
  }

  return [...byToolTokens.entries()]
    .sort(([a], [b]) => a - b)
    .map(([toolTokens, depthFactor]) => ({ toolTokens, depthFactor }));
}

function interpolateDepthFactor(
  anchors: readonly ToolResultDecayPressureAnchor[],
  toolTokens: number
): number {
  if (anchors.length === 0) {
    return 1;
  }

  const normalizedTokens = Math.max(0, toolTokens);
  const first = anchors[0];
  const last = anchors[anchors.length - 1];

  if (anchors.length === 1 || normalizedTokens <= first.toolTokens) {
    return first.depthFactor;
  }

  if (normalizedTokens >= last.toolTokens) {
    return last.depthFactor;
  }

  const logTokens = Math.log(Math.max(1, normalizedTokens));

  for (let i = 1; i < anchors.length; i++) {
    const next = anchors[i];
    if (normalizedTokens > next.toolTokens) {
      continue;
    }

    const previous = anchors[i - 1];
    const start = Math.log(previous.toolTokens);
    const end = Math.log(next.toolTokens);
    const progress = end === start ? 1 : (logTokens - start) / (end - start);
    return previous.depthFactor + progress * (next.depthFactor - previous.depthFactor);
  }

  return last.depthFactor;
}

function estimateToolContextTokens(
  outputCharEstimates: ReadonlyMap<string, number>,
  inputCharEstimates: ReadonlyMap<string, number>
): number {
  let totalChars = 0;

  for (const value of outputCharEstimates.values()) {
    totalChars += value;
  }

  for (const value of inputCharEstimates.values()) {
    totalChars += value;
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

function actionSeverity(action: DecayAction): number {
  switch (action.type) {
    case "full":
      return 0;
    case "truncate":
      return 1;
    case "placeholder":
      return 2;
  }
}

function isForecastWorse(current: DecayAction, forecast: DecayAction): boolean {
  const currentSeverity = actionSeverity(current);
  const forecastSeverity = actionSeverity(forecast);

  if (forecastSeverity > currentSeverity) {
    return true;
  }

  if (forecastSeverity < currentSeverity) {
    return false;
  }

  if (current.type === "truncate" && forecast.type === "truncate") {
    return forecast.maxChars < current.maxChars;
  }

  return false;
}

function classifyExchange(
  depth: number,
  estimatedChars: number,
  baseMaxChars: number,
  placeholderFloorChars: number,
  depthFactor: number
): DecayAction {
  if (depth === 0) {
    return { type: "full" };
  }

  const effectiveDepth = depth * depthFactor;
  if (effectiveDepth < 1) {
    return { type: "full" };
  }

  const maxChars = Math.max(1, Math.floor(baseMaxChars / effectiveDepth));

  if (maxChars < placeholderFloorChars) {
    return { type: "placeholder" };
  }

  if (estimatedChars > maxChars) {
    return { type: "truncate", maxChars };
  }

  return { type: "full" };
}

interface AtRiskExchange {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: LanguageModelV3ToolResultOutput;
  estimatedChars: number;
  currentAction: DecayAction;
  forecastAction: DecayAction;
}

export class ToolResultDecayStrategy implements ContextManagementStrategy {
  readonly name = "tool-result-decay";
  private readonly truncatedMaxTokens: number;
  private readonly placeholderFloorTokens: number;
  private readonly maxPromptTokens?: number;
  private readonly placeholder: string | ((context: DecayedToolContext) => string);
  private readonly decayInputs: boolean;
  private readonly estimator;
  private readonly pressureAnchors: ToolResultDecayPressureAnchor[];
  private readonly warningForecastExtraTokens: number;

  constructor(options: ToolResultDecayStrategyOptions = {}) {
    this.truncatedMaxTokens = Math.max(0, Math.floor(options.truncatedMaxTokens ?? DEFAULT_TRUNCATED_MAX_TOKENS));
    this.placeholderFloorTokens = Math.max(0, Math.floor(options.placeholderFloorTokens ?? DEFAULT_PLACEHOLDER_FLOOR_TOKENS));
    this.maxPromptTokens = options.maxPromptTokens;
    this.placeholder = options.placeholder ?? DEFAULT_PLACEHOLDER;
    this.decayInputs = options.decayInputs ?? true;
    this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    this.pressureAnchors = normalizePressureAnchors(options.pressureAnchors);
    this.warningForecastExtraTokens = Math.max(
      0,
      Math.floor(options.warningForecastExtraTokens ?? DEFAULT_WARNING_FORECAST_EXTRA_TOKENS)
    );
  }

  async apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution> {
    const currentPromptTokens = this.estimator.estimatePrompt(state.prompt)
      + (this.estimator.estimateTools?.(state.params?.tools) ?? 0);

    if (
      this.maxPromptTokens !== undefined &&
      currentPromptTokens <= this.maxPromptTokens
    ) {
      return {
        reason: "below-token-threshold",
        workingTokenBudget: this.maxPromptTokens,
        payloads: {
          kind: "tool-result-decay",
          currentPromptTokens,
          truncatedMaxTokens: this.truncatedMaxTokens,
          placeholderFloorTokens: this.placeholderFloorTokens,
          pressureAnchors: this.pressureAnchors.map((anchor) => ({ ...anchor })),
          warningForecastExtraTokens: this.warningForecastExtraTokens,
        },
      };
    }

    const exchanges = collectToolExchanges(state.prompt);

    if (exchanges.size === 0) {
      return {
        reason: "no-tool-exchanges",
        workingTokenBudget: this.maxPromptTokens,
        payloads: {
          kind: "tool-result-decay",
          currentPromptTokens,
          truncatedMaxTokens: this.truncatedMaxTokens,
          placeholderFloorTokens: this.placeholderFloorTokens,
          pressureAnchors: this.pressureAnchors.map((anchor) => ({ ...anchor })),
          warningForecastExtraTokens: this.warningForecastExtraTokens,
        },
      };
    }

    const turnGroups = new Map<number, ToolExchange[]>();
    for (const exchange of exchanges.values()) {
      const turnKey = exchange.callMessageIndex ?? -1;
      const group = turnGroups.get(turnKey) ?? [];
      group.push(exchange);
      turnGroups.set(turnKey, group);
    }

    const sortedGroups = [...turnGroups.entries()].sort(([a], [b]) => a - b);

    const depthMap = new Map<string, number>();
    const numGroups = sortedGroups.length;
    for (let groupIdx = 0; groupIdx < numGroups; groupIdx++) {
      const depth = numGroups - 1 - groupIdx;
      for (const exchange of sortedGroups[groupIdx][1]) {
        depthMap.set(exchange.toolCallId, depth);
      }
    }

    const sorted = sortedGroups.flatMap(([, group]) => group);

    const baseMaxChars = this.truncatedMaxTokens * CHARS_PER_TOKEN;
    const placeholderFloorChars = this.placeholderFloorTokens * CHARS_PER_TOKEN;

    const charEstimates = new Map<string, number>();
    const originalOutputs = new Map<string, LanguageModelV3ToolResultOutput>();
    const inputs = new Map<string, unknown>();
    const inputCharEstimates = new Map<string, number>();

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

    const toolContextTokens = estimateToolContextTokens(charEstimates, inputCharEstimates);
    const depthFactor = interpolateDepthFactor(this.pressureAnchors, toolContextTokens);
    const forecastToolContextTokens = toolContextTokens + this.warningForecastExtraTokens;
    const forecastDepthFactor = interpolateDepthFactor(this.pressureAnchors, forecastToolContextTokens);

    const actions = new Map<string, DecayAction>();
    for (const exchange of sorted) {
      if (state.pinnedToolCallIds.has(exchange.toolCallId)) {
        actions.set(exchange.toolCallId, { type: "full" });
        continue;
      }

      const depth = depthMap.get(exchange.toolCallId)!;
      const estimatedChars = charEstimates.get(exchange.toolCallId) ?? 0;
      actions.set(
        exchange.toolCallId,
        classifyExchange(depth, estimatedChars, baseMaxChars, placeholderFloorChars, depthFactor)
      );
    }

    const inputActions = new Map<string, DecayAction>();
    if (this.decayInputs) {
      for (const exchange of sorted) {
        if (state.pinnedToolCallIds.has(exchange.toolCallId)) {
          inputActions.set(exchange.toolCallId, { type: "full" });
          continue;
        }

        const depth = depthMap.get(exchange.toolCallId)!;
        const estimatedChars = inputCharEstimates.get(exchange.toolCallId) ?? 0;
        inputActions.set(
          exchange.toolCallId,
          classifyExchange(depth, estimatedChars, baseMaxChars, placeholderFloorChars, depthFactor)
        );
      }
    }

    const atRiskExchanges: AtRiskExchange[] = [];
    for (const exchange of sorted) {
      if (state.pinnedToolCallIds.has(exchange.toolCallId)) {
        continue;
      }

      const depth = depthMap.get(exchange.toolCallId)!;
      const estimatedChars = charEstimates.get(exchange.toolCallId) ?? 0;
      const currentAction = actions.get(exchange.toolCallId)!;

      // Don't warn about results already being decayed in this pass —
      // the agent can't "save" data it can no longer see.
      if (currentAction.type !== "full") {
        continue;
      }

      const forecastAction = classifyExchange(
        depth + 1,
        estimatedChars,
        baseMaxChars,
        placeholderFloorChars,
        forecastDepthFactor
      );

      if (!isForecastWorse(currentAction, forecastAction)) {
        continue;
      }

      atRiskExchanges.push({
        toolCallId: exchange.toolCallId,
        toolName: exchange.toolName,
        input: inputs.get(exchange.toolCallId),
        output: originalOutputs.get(exchange.toolCallId) ?? { type: "text", value: "" },
        estimatedChars,
        currentAction,
        forecastAction,
      });
    }

    let truncatedCount = 0;
    let placeholderCount = 0;
    for (const action of actions.values()) {
      if (action.type === "truncate") truncatedCount++;
      if (action.type === "placeholder") placeholderCount++;
    }

    let inputTruncatedCount = 0;
    let inputPlaceholderCount = 0;
    if (this.decayInputs) {
      for (const action of inputActions.values()) {
        if (action.type === "truncate") inputTruncatedCount++;
        if (action.type === "placeholder") inputPlaceholderCount++;
      }
    }

    const warningToolCallIds = atRiskExchanges.map((entry) => entry.toolCallId);
    const warningTruncateIds = atRiskExchanges
      .filter((entry) => entry.forecastAction.type === "truncate")
      .map((entry) => entry.toolCallId);
    const warningPlaceholderIds = atRiskExchanges
      .filter((entry) => entry.forecastAction.type === "placeholder")
      .map((entry) => entry.toolCallId);

    const hasMutations =
      truncatedCount > 0 ||
      placeholderCount > 0 ||
      inputTruncatedCount > 0 ||
      inputPlaceholderCount > 0;

    if (!hasMutations) {
      if (atRiskExchanges.length > 0) {
        await this.emitDecayWarning(state, atRiskExchanges);
      }

      return {
        reason: "tool-results-decayed",
        workingTokenBudget: this.maxPromptTokens,
        payloads: {
          kind: "tool-result-decay",
          currentPromptTokens,
          toolContextTokens,
          depthFactor,
          forecastToolContextTokens,
          forecastDepthFactor,
          truncatedMaxTokens: this.truncatedMaxTokens,
          placeholderFloorTokens: this.placeholderFloorTokens,
          truncatedCount: 0,
          placeholderCount: 0,
          inputTruncatedCount: 0,
          inputPlaceholderCount: 0,
          totalToolExchanges: exchanges.size,
          warningCount: atRiskExchanges.length,
          warningForecastExtraTokens: this.warningForecastExtraTokens,
          warningToolCallIds,
          warningTruncateIds,
          warningPlaceholderIds,
          pressureAnchors: this.pressureAnchors.map((anchor) => ({ ...anchor })),
        },
      };
    }

    if (atRiskExchanges.length > 0) {
      await this.emitDecayWarning(state, atRiskExchanges);
    }

    const prompt = clonePrompt(state.prompt);
    const removedExchanges: RemovedToolExchange[] = [];

    for (const message of prompt) {
      if (message.role !== "tool" && message.role !== "assistant") {
        continue;
      }

      for (const part of message.content) {
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
                output: originalOutputs.get(part.toolCallId)!,
                action: "truncate",
              });
              const headerChars = header.length;
              const contentBudget = Math.max(0, action.maxChars - headerChars);
              const truncated = truncateToolResultOutput(part.output, contentBudget);
              const truncatedValue = serializeOutputToText(truncated);
              part.output = { type: "text", value: header + truncatedValue };
            } else {
              part.output = truncateToolResultOutput(part.output, action.maxChars);
            }
          } else if (action.type === "placeholder") {
            const placeholderText =
              typeof this.placeholder === "function"
                ? this.placeholder({
                    toolName: part.toolName,
                    toolCallId: part.toolCallId,
                    input: inputs.get(part.toolCallId),
                    output: originalOutputs.get(part.toolCallId)!,
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

        if (part.type === "tool-call" && this.decayInputs) {
          const action = inputActions.get(part.toolCallId);
          if (!action || action.type === "full") {
            continue;
          }

          if (action.type === "truncate") {
            const serialized = safeStringify(part.input);
            (part as { input: unknown }).input = { _truncated: serialized.slice(0, action.maxChars) };
          } else if (action.type === "placeholder") {
            (part as { input: unknown }).input = { _omitted: true };
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
        kind: "tool-result-decay",
        currentPromptTokens,
        toolContextTokens,
        depthFactor,
        forecastToolContextTokens,
        forecastDepthFactor,
        truncatedMaxTokens: this.truncatedMaxTokens,
        placeholderFloorTokens: this.placeholderFloorTokens,
        truncatedCount,
        placeholderCount,
        inputTruncatedCount,
        inputPlaceholderCount,
        totalToolExchanges: exchanges.size,
        warningCount: atRiskExchanges.length,
        warningForecastExtraTokens: this.warningForecastExtraTokens,
        warningToolCallIds,
        warningTruncateIds,
        warningPlaceholderIds,
        pressureAnchors: this.pressureAnchors.map((anchor) => ({ ...anchor })),
      },
    };
  }

  private async emitDecayWarning(
    state: ContextManagementStrategyState,
    atRisk: AtRiskExchange[],
  ): Promise<void> {
    const lines = [
      "The following tool results you used are at risk of being removed from your prompt. If you need to preserve any of it, take note of anything you might need from them:",
    ];

    for (const entry of atRisk) {
      const estimatedTokens = Math.ceil(entry.estimatedChars / CHARS_PER_TOKEN);

      if (typeof this.placeholder === "function") {
        const formattedAction = entry.forecastAction.type === "placeholder" ? "placeholder" : "truncate";
        const formatted = this.placeholder({
          toolName: entry.toolName,
          toolCallId: entry.toolCallId,
          input: entry.input,
          output: entry.output,
          action: formattedAction,
        });
        lines.push(`- ${formatted} (~${estimatedTokens.toLocaleString("en-US")} tokens)`);
        continue;
      }

      lines.push(
        `- [${entry.toolCallId}] [${entry.toolName}] (~${estimatedTokens.toLocaleString("en-US")} tokens)`
      );
    }

    await state.emitReminder({
      kind: "tool-result-decay",
      content: lines.join("\n"),
    });
  }
}
