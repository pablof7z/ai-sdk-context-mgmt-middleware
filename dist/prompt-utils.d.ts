import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { ContextManagementRequestContext, PromptTokenEstimator, RemovedToolExchange } from "./types.js";
interface ToolExchange {
    toolCallId: string;
    toolName: string;
    callMessageIndex?: number;
    resultMessageIndices: number[];
}
export declare function clonePrompt(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt;
export declare function extractRequestContext(params: Pick<LanguageModelV3CallOptions, "providerOptions">): ContextManagementRequestContext | null;
export declare function collectToolExchanges(prompt: LanguageModelV3Prompt): Map<string, ToolExchange>;
export declare function removeToolExchanges(prompt: LanguageModelV3Prompt, toolCallIds: readonly string[], reason: string): {
    prompt: LanguageModelV3Prompt;
    removedToolExchanges: RemovedToolExchange[];
};
export declare function trimPromptToLastMessages(prompt: LanguageModelV3Prompt, keepLastMessages: number, reason: string, options?: {
    estimator?: PromptTokenEstimator;
    maxPromptTokens?: number;
}): {
    prompt: LanguageModelV3Prompt;
    removedToolExchanges: RemovedToolExchange[];
};
export declare function appendReminderToLatestUserMessage(prompt: LanguageModelV3Prompt, reminderText: string): LanguageModelV3Prompt;
export {};
