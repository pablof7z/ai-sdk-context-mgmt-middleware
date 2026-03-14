import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
const DEFAULT_WARNING_THRESHOLD_RATIO = 0.7;
function buildReminder(options) {
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
    }
    else {
        lines.push("Your working context is getting tight. Trim or summarize stale context before continuing.");
    }
    lines.push("[/Context utilization]");
    return lines.join("\n");
}
export class ContextUtilizationReminderStrategy {
    name = "context-utilization-reminder";
    workingTokenBudget;
    warningThresholdRatio;
    estimator;
    mode;
    constructor(options) {
        this.workingTokenBudget = Math.max(1, Math.floor(options.workingTokenBudget));
        this.warningThresholdRatio = Math.min(1, Math.max(0, options.warningThresholdRatio ?? DEFAULT_WARNING_THRESHOLD_RATIO));
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
        this.mode = options.mode ?? "generic";
    }
    async apply(state) {
        const currentTokens = this.estimator.estimatePrompt(state.prompt)
            + (this.estimator.estimateTools?.(state.params?.tools) ?? 0);
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
        await state.emitReminder({
            kind: "context-utilization",
            content: reminderText,
        });
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
