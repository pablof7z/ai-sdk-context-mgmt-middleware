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
    const { estimatedRequestTokens, estimatedMessageTokens, estimatedToolTokens, rawContextWindow, workingTokenBudget, } = options;
    const lines = [
        "[Context status]",
        `Current request after context management: ~${formatNumber(estimatedRequestTokens)} tokens.`,
    ];
    if (estimatedMessageTokens !== undefined
        && estimatedToolTokens !== undefined
        && estimatedToolTokens > 0) {
        lines.push(`Breakdown: ~${formatNumber(estimatedMessageTokens)} message tokens + ~${formatNumber(estimatedToolTokens)} tool-definition tokens.`);
    }
    if (workingTokenBudget !== undefined) {
        lines.push(`Working budget target: ~${formatNumber(workingTokenBudget)} tokens (~${formatPercent(estimatedRequestTokens, workingTokenBudget)}% used).`);
    }
    if (rawContextWindow !== undefined) {
        lines.push(`Raw model context window: ~${formatNumber(rawContextWindow)} tokens (~${formatPercent(estimatedRequestTokens, rawContextWindow)}% used).`);
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
        const estimatedMessageTokens = this.estimator.estimatePrompt(state.prompt);
        const estimatedToolTokens = this.estimator.estimateTools?.(state.params?.tools) ?? 0;
        const estimatedRequestTokens = estimatedMessageTokens + estimatedToolTokens;
        const rawContextWindow = this.getContextWindow?.({
            model: state.model,
            requestContext: state.requestContext,
        });
        if (this.workingTokenBudget === undefined && rawContextWindow === undefined) {
            return {
                outcome: "skipped",
                reason: "no-context-capacity-data",
                payloads: {
                    estimatedPromptTokens: estimatedRequestTokens,
                    estimatedMessageTokens,
                    estimatedToolTokens,
                },
            };
        }
        const reminderText = buildReminder({
            estimatedRequestTokens,
            estimatedMessageTokens,
            estimatedToolTokens,
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
                estimatedPromptTokens: estimatedRequestTokens,
                estimatedMessageTokens,
                estimatedToolTokens,
                rawContextWindow,
                rawContextUtilizationPercent: rawContextWindow !== undefined
                    ? formatPercent(estimatedRequestTokens, rawContextWindow)
                    : undefined,
                workingTokenBudget: this.workingTokenBudget,
                workingBudgetUtilizationPercent: this.workingTokenBudget !== undefined
                    ? formatPercent(estimatedRequestTokens, this.workingTokenBudget)
                    : undefined,
                reminderText,
            },
        };
    }
}
