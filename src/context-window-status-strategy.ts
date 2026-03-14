import { appendReminderToLatestUserMessage } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import type {
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  ContextWindowStatusStrategyOptions,
  PromptTokenEstimator,
} from "./types.js";

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 100);
}

function buildReminder(options: {
  estimatedPromptTokens: number;
  rawContextWindow?: number;
  workingTokenBudget?: number;
}): string {
  const { estimatedPromptTokens, rawContextWindow, workingTokenBudget } = options;
  const lines = [
    "[Context status]",
    `Current prompt after context management: ~${formatNumber(estimatedPromptTokens)} tokens.`,
  ];

  if (workingTokenBudget !== undefined) {
    lines.push(
      `Working budget target: ~${formatNumber(workingTokenBudget)} tokens (~${formatPercent(estimatedPromptTokens, workingTokenBudget)}% used).`
    );
  }

  if (rawContextWindow !== undefined) {
    lines.push(
      `Raw model context window: ~${formatNumber(rawContextWindow)} tokens (~${formatPercent(estimatedPromptTokens, rawContextWindow)}% used).`
    );
  }

  lines.push("[/Context status]");
  return lines.join("\n");
}

export class ContextWindowStatusStrategy implements ContextManagementStrategy {
  readonly name = "context-window-status";
  private readonly workingTokenBudget?: number;
  private readonly estimator: PromptTokenEstimator;
  private readonly getContextWindow?: ContextWindowStatusStrategyOptions["getContextWindow"];

  constructor(options: ContextWindowStatusStrategyOptions = {}) {
    this.workingTokenBudget = typeof options.workingTokenBudget === "number"
      && Number.isFinite(options.workingTokenBudget)
      && options.workingTokenBudget > 0
      ? Math.floor(options.workingTokenBudget)
      : undefined;
    this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    this.getContextWindow = options.getContextWindow;
  }

  apply(state: ContextManagementStrategyState): ContextManagementStrategyExecution {
    const estimatedPromptTokens = this.estimator.estimatePrompt(state.prompt);
    const rawContextWindow = this.getContextWindow?.({
      model: state.model,
      requestContext: state.requestContext,
    });

    if (this.workingTokenBudget === undefined && rawContextWindow === undefined) {
      return {
        outcome: "skipped",
        reason: "no-context-capacity-data",
        payloads: {
          estimatedPromptTokens,
        },
      };
    }

    const reminderText = buildReminder({
      estimatedPromptTokens,
      rawContextWindow,
      workingTokenBudget: this.workingTokenBudget,
    });

    state.updatePrompt(appendReminderToLatestUserMessage(state.prompt, reminderText));

    return {
      reason: "context-window-status-injected",
      ...(this.workingTokenBudget !== undefined
        ? { workingTokenBudget: this.workingTokenBudget }
        : {}),
      payloads: {
        estimatedPromptTokens,
        rawContextWindow,
        rawContextUtilizationPercent: rawContextWindow !== undefined
          ? formatPercent(estimatedPromptTokens, rawContextWindow)
          : undefined,
        workingTokenBudget: this.workingTokenBudget,
        workingBudgetUtilizationPercent: this.workingTokenBudget !== undefined
          ? formatPercent(estimatedPromptTokens, this.workingTokenBudget)
          : undefined,
        reminderText,
      },
    };
  }
}
