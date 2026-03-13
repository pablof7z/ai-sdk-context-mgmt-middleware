import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { ToolSet } from "ai";

export const CONTEXT_MANAGEMENT_KEY = "contextManagement";

export interface ContextManagementRequestContext {
  conversationId: string;
  agentId: string;
  agentLabel?: string;
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
  readonly removedToolExchanges: readonly RemovedToolExchange[];
  updatePrompt(prompt: LanguageModelV3Prompt): void;
  addRemovedToolExchanges(exchanges: RemovedToolExchange[]): void;
}

export interface ContextManagementStrategy {
  readonly name?: string;
  apply(state: ContextManagementStrategyState): Promise<void> | void;
  getOptionalTools?(): ToolSet;
}

export interface CreateContextManagementRuntimeOptions {
  strategies: ContextManagementStrategy[];
}

export interface ContextManagementRuntime {
  middleware: LanguageModelV3Middleware;
  optionalTools: ToolSet;
}

export interface PromptTokenEstimator {
  estimatePrompt(prompt: LanguageModelV3Prompt): number;
  estimateMessage(message: LanguageModelV3Message): number;
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
  listConversation(
    conversationId: string
  ): Promise<ScratchpadConversationEntry[] | undefined> | ScratchpadConversationEntry[] | undefined;
}

export interface ScratchpadStrategyOptions {
  scratchpadStore: ScratchpadStore;
  maxScratchpadChars?: number;
  maxRemovedToolReminderItems?: number;
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
