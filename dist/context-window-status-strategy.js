import { createDefaultPromptTokenEstimator } from "./token-estimator.js";
function formatNumber(value) {
    return value.toLocaleString("en-US");
}
function formatPercent(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
        return 0;
    }
    return Math.round((numerator / denominator) * 100);
}
function buildReminder(options) {
    const { estimatedPromptTokens, rawContextWindow, workingTokenBudget } = options;
    const lines = [
        "[Context status]",
        `Current prompt after context management: ~${formatNumber(estimatedPromptTokens)} tokens.`,
    ];
    if (workingTokenBudget !== undefined) {
        lines.push(`Working budget target: ~${formatNumber(workingTokenBudget)} tokens (~${formatPercent(estimatedPromptTokens, workingTokenBudget)}% used).`);
    }
    if (rawContextWindow !== undefined) {
        lines.push(`Raw model context window: ~${formatNumber(rawContextWindow)} tokens (~${formatPercent(estimatedPromptTokens, rawContextWindow)}% used).`);
    }
    lines.push("[/Context status]");
    return lines.join("\n");
}
export class ContextWindowStatusStrategy {
    name = "context-window-status";
    workingTokenBudget;
    estimator;
    getContextWindow;
    constructor(options = {}) {
        this.workingTokenBudget = typeof options.workingTokenBudget === "number"
            && Number.isFinite(options.workingTokenBudget)
            && options.workingTokenBudget > 0
            ? Math.floor(options.workingTokenBudget)
            : undefined;
        this.estimator = options.estimator ?? createDefaultPromptTokenEstimator();
        this.getContextWindow = options.getContextWindow;
    }
    async apply(state) {
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
        await state.emitReminder({
            kind: "context-window-status",
            content: reminderText,
        });
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
