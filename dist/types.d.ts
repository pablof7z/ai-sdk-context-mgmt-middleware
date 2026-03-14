import type { LanguageModelV3CallOptions, LanguageModelV3Message, LanguageModelV3Middleware, LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { LanguageModel, ToolSet } from "ai";
export declare const CONTEXT_MANAGEMENT_KEY = "contextManagement";
export interface ContextManagementRequestContext {
    conversationId: string;
    agentId: string;
    agentLabel?: string;
}
export interface ContextManagementModelRef {
    provider: string;
    modelId: string;
}
export interface RemovedToolExchange {
    toolCallId: string;
    toolName: string;
    reason: string;
}
export interface ContextManagementStrategyState {
    readonly params: LanguageModelV3CallOptions;
    readonly prompt: LanguageModelV3Prompt;
    readonly requestContext: ContextManagementRequestContext;
    readonly model?: ContextManagementModelRef;
    readonly removedToolExchanges: readonly RemovedToolExchange[];
    readonly pinnedToolCallIds: ReadonlySet<string>;
    updatePrompt(prompt: LanguageModelV3Prompt): void;
    updateParams(patch: Partial<LanguageModelV3CallOptions>): void;
    addRemovedToolExchanges(exchanges: RemovedToolExchange[]): void;
    addPinnedToolCallIds(toolCallIds: string[]): void;
}
export interface ContextManagementStrategyExecution {
    outcome?: "applied" | "skipped";
    reason?: string;
    workingTokenBudget?: number;
    payloads?: Record<string, unknown>;
}
export interface ContextManagementStrategy {
    readonly name?: string;
    apply(state: ContextManagementStrategyState): Promise<ContextManagementStrategyExecution | void> | ContextManagementStrategyExecution | void;
    getOptionalTools?(): ToolSet;
}
export interface ContextManagementRuntimeStartEvent {
    type: "runtime-start";
    requestContext: ContextManagementRequestContext;
    strategyNames: string[];
    optionalToolNames: string[];
    estimatedTokensBefore: number;
    payloads: {
        prompt: LanguageModelV3Prompt;
        providerOptions: LanguageModelV3CallOptions["providerOptions"];
    };
}
export interface ContextManagementStrategyCompleteEvent {
    type: "strategy-complete";
    requestContext: ContextManagementRequestContext;
    strategyName: string;
    outcome: "applied" | "skipped";
    reason: string;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    workingTokenBudget?: number;
    removedToolExchangesDelta: number;
    removedToolExchangesTotal: number;
    pinnedToolCallIdsDelta: number;
    payloads: {
        promptBefore: LanguageModelV3Prompt;
        promptAfter: LanguageModelV3Prompt;
        strategy?: Record<string, unknown>;
    };
}
export interface ContextManagementToolExecuteStartEvent {
    type: "tool-execute-start";
    toolName: string;
    strategyName?: string;
    toolCallId?: string;
    requestContext: ContextManagementRequestContext | null;
    payloads: {
        input: unknown;
    };
}
export interface ContextManagementToolExecuteCompleteEvent {
    type: "tool-execute-complete";
    toolName: string;
    strategyName?: string;
    toolCallId?: string;
    requestContext: ContextManagementRequestContext | null;
    payloads: {
        input: unknown;
        result: unknown;
    };
}
export interface ContextManagementToolExecuteErrorEvent {
    type: "tool-execute-error";
    toolName: string;
    strategyName?: string;
    toolCallId?: string;
    requestContext: ContextManagementRequestContext | null;
    payloads: {
        input: unknown;
        error: unknown;
    };
}
export interface ContextManagementRuntimeCompleteEvent {
    type: "runtime-complete";
    requestContext: ContextManagementRequestContext;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    removedToolExchangesTotal: number;
    pinnedToolCallIdsTotal: number;
    payloads: {
        promptBefore: LanguageModelV3Prompt;
        promptAfter: LanguageModelV3Prompt;
    };
}
export type ContextManagementTelemetryEvent = ContextManagementRuntimeStartEvent | ContextManagementStrategyCompleteEvent | ContextManagementToolExecuteStartEvent | ContextManagementToolExecuteCompleteEvent | ContextManagementToolExecuteErrorEvent | ContextManagementRuntimeCompleteEvent;
export type ContextManagementTelemetrySink = (event: ContextManagementTelemetryEvent) => Promise<void> | void;
export interface CreateContextManagementRuntimeOptions {
    strategies: ContextManagementStrategy[];
    telemetry?: ContextManagementTelemetrySink;
    estimator?: PromptTokenEstimator;
}
export interface ContextManagementRuntime {
    middleware: LanguageModelV3Middleware;
    optionalTools: ToolSet;
}
export interface PromptTokenEstimator {
    estimatePrompt(prompt: LanguageModelV3Prompt): number;
    estimateMessage(message: LanguageModelV3Message): number;
    estimateTools?(tools: LanguageModelV3CallOptions["tools"]): number;
}
export interface ToolResultDecayStrategyOptions {
    keepFullResultCount?: number;
    truncatedMaxTokens?: number;
    truncateWindowCount?: number;
    maxPromptTokens?: number;
    placeholder?: string | ((toolName: string, toolCallId: string) => string);
    estimator?: PromptTokenEstimator;
}
export interface HeadAndTailStrategyOptions {
    headCount?: number;
    tailCount?: number;
}
export interface SystemPromptCachingStrategyOptions {
    consolidateSystemMessages?: boolean;
}
export interface ContextUtilizationReminderStrategyOptions {
    workingTokenBudget: number;
    warningThresholdRatio?: number;
    estimator?: PromptTokenEstimator;
    mode?: "scratchpad" | "generic";
}
export interface ContextWindowStatusStrategyOptions {
    workingTokenBudget?: number;
    estimator?: PromptTokenEstimator;
    getContextWindow?: (options: {
        model?: ContextManagementModelRef;
        requestContext: ContextManagementRequestContext;
    }) => number | undefined;
}
export interface SummarizationStrategyOptions {
    summarize: (messages: LanguageModelV3Message[]) => Promise<string>;
    maxPromptTokens: number;
    keepLastMessages?: number;
    estimator?: PromptTokenEstimator;
}
export interface LlmSummarizerFormattingOptions {
    maxTranscriptChars?: number;
    maxPartChars?: number;
    deterministicSummaryMaxChars?: number;
}
export interface LlmSummarizerOptions {
    model: LanguageModel;
    providerOptions?: LanguageModelV3CallOptions["providerOptions"];
    maxOutputTokens?: number;
    systemPrompt?: string;
    temperature?: number;
    formatting?: LlmSummarizerFormattingOptions;
}
export interface LLMSummarizationStrategyOptions extends Omit<SummarizationStrategyOptions, "summarize">, LlmSummarizerOptions {
}
export interface CompactionStoreKey {
    conversationId: string;
    agentId: string;
}
export interface CompactionStore {
    get(key: CompactionStoreKey): Promise<string | undefined> | string | undefined;
    set(key: CompactionStoreKey, summary: string): Promise<void> | void;
}
export interface CompactionToolStrategyOptions {
    summarize: (messages: LanguageModelV3Message[]) => Promise<string>;
    keepLastMessages?: number;
    compactionStore?: CompactionStore;
    estimator?: PromptTokenEstimator;
}
export interface PinnedStoreKey {
    conversationId: string;
    agentId: string;
}
export interface PinnedStore {
    get(key: PinnedStoreKey): Promise<string[]> | string[];
    set(key: PinnedStoreKey, toolCallIds: string[]): Promise<void> | void;
}
export interface PinnedMessagesStrategyOptions {
    pinnedStore: PinnedStore;
    maxPinned?: number;
}
export interface SlidingWindowStrategyOptions {
    keepLastMessages?: number;
    maxPromptTokens?: number;
    estimator?: PromptTokenEstimator;
}
export interface ScratchpadStoreKey {
    conversationId: string;
    agentId: string;
}
export interface ScratchpadState {
    notes: string;
    keepLastMessages?: number | null;
    omitToolCallIds: string[];
    updatedAt?: number;
    agentLabel?: string;
}
export interface ScratchpadConversationEntry {
    agentId: string;
    agentLabel?: string;
    state: ScratchpadState;
}
export interface ScratchpadStore {
    get(key: ScratchpadStoreKey): Promise<ScratchpadState | undefined> | ScratchpadState | undefined;
    set(key: ScratchpadStoreKey, state: ScratchpadState): Promise<void> | void;
    listConversation(conversationId: string): Promise<ScratchpadConversationEntry[] | undefined> | ScratchpadConversationEntry[] | undefined;
}
export interface ScratchpadStrategyOptions {
    scratchpadStore: ScratchpadStore;
    reminderTone?: "informational" | "urgent" | "silent";
    maxRemovedToolReminderItems?: number;
    workingTokenBudget?: number;
    forceToolThresholdRatio?: number;
    estimator?: PromptTokenEstimator;
}
export interface ScratchpadToolInput {
    notes?: string;
    keepLastMessages?: number | null;
    omitToolCallIds?: string[];
}
export interface ScratchpadToolResult {
    ok: true;
    state: ScratchpadState;
}
