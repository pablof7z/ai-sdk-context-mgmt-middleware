import type { LanguageModelV3CallOptions, LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { ContextManagementRequestContext, PromptTokenEstimator, RemovedToolExchange, ScratchpadUseNotice } from "./types.js";
export interface ToolExchange {
    toolCallId: string;
    toolName: string;
    callMessageIndex?: number;
    resultMessageIndices: number[];
}
type PromptLikeMessage = {
    role: string;
    content: unknown;
};
export declare function buildScratchpadUseNoticeText(description: string): string;
export declare function buildScratchpadUseNoticeMessage(description: string): LanguageModelV3Message;
export declare function countScratchpadSemanticTurns(messages: readonly PromptLikeMessage[]): number;
export declare function countProjectedScratchpadTurns(messages: readonly PromptLikeMessage[], preserveTurns?: number | null): number;
export declare function projectScratchpadPrompt(prompt: LanguageModelV3Prompt, options: {
    preserveTurns?: number | null;
    notice?: ScratchpadUseNotice;
}): LanguageModelV3Prompt;
export declare function isContextManagementSystemMessage(message: LanguageModelV3Message): boolean;
export declare function getPinnedMessageIndices(prompt: LanguageModelV3Prompt, pinnedToolCallIds: ReadonlySet<string>): Set<number>;
export declare function buildPromptFromSelectedIndices(prompt: LanguageModelV3Prompt, selectedIndices: ReadonlySet<number>): LanguageModelV3Prompt;
export declare function clonePrompt(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt;
export declare function extractRequestContext(params: Pick<LanguageModelV3CallOptions, "providerOptions">): ContextManagementRequestContext | null;
export declare function collectToolExchanges(prompt: LanguageModelV3Prompt): Map<string, ToolExchange>;
export declare function getLatestToolActivity(prompt: LanguageModelV3Prompt): {
    toolCallId: string;
    toolName: string;
    type: "tool-call" | "tool-result";
} | null;
export declare function removeToolExchanges(prompt: LanguageModelV3Prompt, toolCallIds: readonly string[], reason: string): {
    prompt: LanguageModelV3Prompt;
    removedToolExchanges: RemovedToolExchange[];
};
export declare function trimPromptToLastMessages(prompt: LanguageModelV3Prompt, keepLastMessages: number, reason: string, options?: {
    headCount?: number;
    estimator?: PromptTokenEstimator;
    maxPromptTokens?: number;
    pinnedToolCallIds?: ReadonlySet<string>;
}): {
    prompt: LanguageModelV3Prompt;
    removedToolExchanges: RemovedToolExchange[];
};
export declare function trimPromptHeadAndTail(prompt: LanguageModelV3Prompt, headCount: number, tailCount: number, reason: string, options?: {
    pinnedToolCallIds?: ReadonlySet<string>;
}): {
    prompt: LanguageModelV3Prompt;
    removedToolExchanges: RemovedToolExchange[];
};
export declare function trimPromptHeadAndTailAroundAnchor(prompt: LanguageModelV3Prompt, headCount: number, tailCount: number, anchorToolCallId: string, reason: string, options?: {
    pinnedToolCallIds?: ReadonlySet<string>;
}): {
    prompt: LanguageModelV3Prompt;
    removedToolExchanges: RemovedToolExchange[];
};
export declare function partitionPromptForSummarization(prompt: LanguageModelV3Prompt, keepLastMessages: number, pinnedToolCallIds?: ReadonlySet<string>): {
    systemMessages: LanguageModelV3Message[];
    summarizableMessages: LanguageModelV3Message[];
    preservedMessages: LanguageModelV3Message[];
};
export declare function appendReminderToLatestUserMessage(prompt: LanguageModelV3Prompt, reminderText: string): LanguageModelV3Prompt;
export {};
