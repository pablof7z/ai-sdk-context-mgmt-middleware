import { appendReminderToLatestUserMessage } from "./prompt-utils.js";
import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
import type {
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  ContextUtilizationReminderStrategyOptions,
  PromptTokenEstimator,
} from "./types.js";

const DEFAULT_WARNING_THRESHOLD_RATIO = 0.7;

function buildReminder(options: {
  currentTokens: number;
  warningThresholdTokens: number;
  utilizationPercent: number;
  mode: "scratchpad" | "generic";
}): string {
  const { currentTokens, warningThresholdTokens, utilizationPercent, mode } = options;

  const lines = [
    `[Context utilization: ~${utilizationPercent}% of working budget]`,
    `Current prompt tokens: ~${currentTokens}. Warning threshold: ~${warningThresholdTokens}.`,
  ];

  if (mode === "scratchpad") {
    lines.push("Your working context is getting tight. Use scratchpad(...) now to:");
    lines.push("- Save your current progress, findings, and next steps");
    lines.push("- Omit stale tool call IDs you no longer need");
    lines.push("- Reduce keepLastMessages if the recent tail is larger than necessary");
  } else {
    lines.push("Your working context is getting tight. Trim or summarize stale context before continuing.");
  }

  lines.push("[/Context utilization]");
  return lines.join("\n");
}

export class ContextUtilizationReminderStrategy implements ContextManagementStrategy {
  readonly name = "context-utilization-reminder";
  private readonly workingTokenBudget: number;
  private readonly warningThresholdRatio: number;
  private readonly estimator: PromptTokenEstimator;
  private readonly mode: "scratchpad" | "generic";

  constructor(options: ContextUtilizationReminderStrategyOptions) {
    this.workingTokenBudget = Math.max(1, Math.floor(options.workingTokenBudget));
    this.warningThresholdRatio = Math.min(
      1,
      Math.max(0, options.warningThresholdRatio ?? DEFAULT_WARNING_THRESHOLD_RATIO)
    );
    this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
    this.mode = options.mode ?? "generic";
  }

  apply(state: ContextManagementStrategyState): ContextManagementStrategyExecution {
    const currentTokens = this.estimator.estimatePrompt(state.prompt);
    const warningThresholdTokens = Math.floor(this.workingTokenBudget * this.warningThresholdRatio);

    if (currentTokens < warningThresholdTokens) {
      return {
        reason: "below-warning-threshold",
        workingTokenBudget: this.workingTokenBudget,
        payloads: {
          currentTokens,
          warningThresholdTokens,
          warningThresholdRatio: this.warningThresholdRatio,
          mode: this.mode,
        },
      };
    }

    const utilizationPercent = Math.round((currentTokens / this.workingTokenBudget) * 100);
    const reminderText = buildReminder({
      currentTokens,
      warningThresholdTokens,
      utilizationPercent,
      mode: this.mode,
    });

    state.updatePrompt(appendReminderToLatestUserMessage(state.prompt, reminderText));

    return {
      reason: "warning-injected",
      workingTokenBudget: this.workingTokenBudget,
      payloads: {
        currentTokens,
        warningThresholdTokens,
        warningThresholdRatio: this.warningThresholdRatio,
        utilizationPercent,
        mode: this.mode,
        reminderText,
      },
    };
  }
}
