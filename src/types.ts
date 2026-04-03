import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";
import type { LanguageModel, ModelMessage, ToolChoice, ToolSet } from "ai";

export const CONTEXT_MANAGEMENT_KEY = "contextManagement";

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

export type ReminderPlacement =
  | "overlay-user"
  | "latest-user-append"
  | "fallback-system";

export interface ContextManagementReminder {
  kind: string;
  content: string;
  attributes?: Record<string, string>;
  disposition?: "queue" | "defer";
  placement?: ReminderPlacement;
  deliveryMode?: "stateful" | "transient";
}

export interface ReminderDescriptor {
  type: string;
  content: string;
  attributes?: Record<string, string>;
}

export interface ReminderRuntimeOverlay {
  overlayType: string;
  message: ModelMessage;
}

export interface ReminderStateStoreKey {
  conversationId: string;
  agentId: string;
}

export interface ReminderProviderState {
  snapshot: unknown;
  turnsSinceFullState: number;
}

export interface ReminderState {
  providers: Record<string, ReminderProviderState>;
  deferred: ContextManagementReminder[];
}

export interface ReminderStateStore {
  get(key: ReminderStateStoreKey): Promise<ReminderState | undefined> | ReminderState | undefined;
  set(key: ReminderStateStoreKey, state: ReminderState): Promise<void> | void;
}

export interface ReminderProviderContext<TData = unknown> {
  data: TData | undefined;
  prompt: LanguageModelV3Prompt;
  requestContext: ContextManagementRequestContext;
  model?: ContextManagementModelRef;
  tools?: ToolSet;
}

export type ReminderProviderDeltaResult = ReminderDescriptor | null | "full";

export interface ReminderProvider<TData = unknown, TSnapshot = unknown> {
  type: string;
  fullInterval?: number;
  placement?:
    | ReminderPlacement
    | ((context: ReminderProviderContext<TData>) => ReminderPlacement);
  snapshot(
    data: TData | undefined,
    context: ReminderProviderContext<TData>
  ): TSnapshot | Promise<TSnapshot>;
  renderFull(
    snapshot: TSnapshot,
    data: TData | undefined,
    context: ReminderProviderContext<TData>
  ): ReminderDescriptor | null | Promise<ReminderDescriptor | null>;
  renderDelta?(
    previous: TSnapshot,
    current: TSnapshot,
    data: TData | undefined,
    context: ReminderProviderContext<TData>
  ): ReminderProviderDeltaResult | Promise<ReminderProviderDeltaResult>;
}

export interface ReminderPlacementPolicyContext<TData = unknown> extends ReminderProviderContext<TData> {
  type: string;
  defaultPlacement: ReminderPlacement;
  builtIn: boolean;
}

export type ReminderPlacementPolicy<TData = unknown> = (
  context: ReminderPlacementPolicyContext<TData>
) => ReminderPlacement;

export interface ContextManagementRequestParams {
  prompt: LanguageModelV3Prompt;
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  providerOptions?: LanguageModelV3CallOptions["providerOptions"];
  reminderData?: unknown;
  queuedReminders?: ContextManagementReminder[];
}

export interface ContextManagementStrategyState {
  readonly params: ContextManagementRequestParams;
  readonly prompt: LanguageModelV3Prompt;
  readonly requestContext: ContextManagementRequestContext;
  readonly model?: ContextManagementModelRef;
  readonly lastReportedModelInputTokens?: number;
  readonly reminderData?: unknown;
  readonly removedToolExchanges: readonly RemovedToolExchange[];
  readonly pinnedToolCallIds: ReadonlySet<string>;
  updatePrompt(prompt: LanguageModelV3Prompt): void;
  updateParams(patch: Partial<ContextManagementRequestParams>): void;
  addRemovedToolExchanges(exchanges: RemovedToolExchange[]): void;
  addPinnedToolCallIds(toolCallIds: string[]): void;
  addRuntimeOverlay(overlay: ReminderRuntimeOverlay): void;
  consumeReminderQueue(): ContextManagementReminder[];
  emitReminder(reminder: ContextManagementReminder): Promise<void>;
}

export interface ContextManagementStrategyExecution {
  outcome?: "applied" | "skipped";
  reason?: string;
  workingTokenBudget?: number;
  payloads?: ContextManagementStrategyPayload | Record<string, unknown>;
}

export interface ContextManagementStrategy {
  readonly name?: string;
  apply(
    state: ContextManagementStrategyState
  ): Promise<ContextManagementStrategyExecution | void> | ContextManagementStrategyExecution | void;
  getOptionalTools?(): ToolSet;
}

export interface ContextManagementRuntimeStartEvent {
  type: "runtime-start";
  requestContext: ContextManagementRequestContext;
  strategyNames: string[];
  optionalToolNames: string[];
  estimatedTokensBefore: number;
  messageCount: number;
  payloads: {
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
  messageCountBefore: number;
  messageCountAfter: number;
  strategyPayload?: ContextManagementStrategyPayload;
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
  messageCountBefore: number;
  messageCountAfter: number;
  payloads: {
    prompt: LanguageModelV3Prompt;
    providerOptions: LanguageModelV3CallOptions["providerOptions"];
    toolChoice?: ToolChoice<ToolSet>;
  };
}

export interface ContextManagementCalibrationEvent {
  type: "calibration-update";
  requestContext: ContextManagementRequestContext;
  rawEstimate: number;
  actualTokens: number;
  previousFactor: number;
  newFactor: number;
  sampleCount: number;
}

export type ContextManagementTelemetryEvent =
  | ContextManagementRuntimeStartEvent
  | ContextManagementStrategyCompleteEvent
  | ContextManagementToolExecuteStartEvent
  | ContextManagementToolExecuteCompleteEvent
  | ContextManagementToolExecuteErrorEvent
  | ContextManagementRuntimeCompleteEvent
  | ContextManagementCalibrationEvent;

export type ContextManagementTelemetrySink = (
  event: ContextManagementTelemetryEvent
) => Promise<void> | void;

export interface CreateContextManagementRuntimeOptions {
  strategies: ContextManagementStrategy[];
  telemetry?: ContextManagementTelemetrySink;
  estimator?: PromptTokenEstimator;
}

export interface PrepareContextManagementRequestOptions {
  requestContext: ContextManagementRequestContext;
  messages: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  providerOptions?: LanguageModelV3CallOptions["providerOptions"];
  model?: ContextManagementModelRef;
  reminderData?: unknown;
  queuedReminders?: ContextManagementReminder[];
}

export interface ContextManagementPreparedRequest {
  messages: ModelMessage[];
  providerOptions?: LanguageModelV3CallOptions["providerOptions"];
  toolChoice?: ToolChoice<ToolSet>;
  runtimeOverlays?: ReminderRuntimeOverlay[];
  reportActualUsage(actualInputTokens: number | null | undefined): Promise<void>;
}

export interface SharedPrefixObservation {
  sharedPrefixMessageCount: number;
  lastSharedMessageIndex?: number;
  hasSharedPrefix: boolean;
}

export interface SharedPrefixTracker {
  observe(prompt: LanguageModelV3Prompt): SharedPrefixObservation;
}

export interface ContextManagementRuntime {
  prepareRequest(
    options: PrepareContextManagementRequestOptions
  ): Promise<ContextManagementPreparedRequest>;
  optionalTools: ToolSet;
}

export interface PromptTokenEstimator {
  estimatePrompt(prompt: LanguageModelV3Prompt): number;
  estimateMessage(message: LanguageModelV3Message): number;
  estimateTools?(tools: ToolSet | undefined): number;
}

export interface CalibratingEstimator extends PromptTokenEstimator {
  reportActualUsage(rawEstimate: number, actualTokens: number): void;
  readonly calibrationFactor: number;
  readonly calibrationSamples: number;
}

export interface ContextBudgetProfile {
  tokenBudget: number;
  estimator: PromptTokenEstimator;
  label?: string;
  description?: string;
}

export interface DecayedToolContext {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: LanguageModelV3ToolResultOutput;
}

export interface ToolResultDecayPressureAnchor {
  toolTokens: number;
  depthFactor: number;
}

export interface ToolResultDecayStrategyOptions {
  maxResultTokens?: number;
  placeholderMinSourceTokens?: number;
  placeholder?: string | ((context: DecayedToolContext) => string);
  decayInputs?: boolean;
  estimator?: PromptTokenEstimator;
  pressureAnchors?: ToolResultDecayPressureAnchor[];
  warningForecastExtraTokens?: number;
}

export interface ReminderContextUtilizationSourceOptions {
  budgetProfile: ContextBudgetProfile;
  warningThresholdRatio?: number;
  mode?: "scratchpad" | "generic";
  placement?: ReminderPlacement;
}

export interface ReminderContextWindowStatusSourceOptions {
  getContextWindow?: (options: {
    model?: ContextManagementModelRef;
    requestContext: ContextManagementRequestContext;
  }) => number | undefined;
  placement?: ReminderPlacement;
}

export interface RemindersStrategyOptions<TData = unknown> {
  stateStore?: ReminderStateStore;
  providers?: Array<ReminderProvider<TData, unknown>>;
  placementPolicy?: ReminderPlacementPolicy<TData>;
  contextUtilization?: false | ReminderContextUtilizationSourceOptions;
  contextWindowStatus?: false | ReminderContextWindowStatusSourceOptions;
  overlayType?: string;
}

export interface AnthropicPromptCachingStrategyOptions {
  ttl?: "5m" | "1h";
  clearToolUses?: boolean;
}

export interface SummarizationStrategyOptions {
  maxPromptTokens: number;
  preserveRecentMessages?: number;
  estimator?: PromptTokenEstimator;
  summarize?: (messages: LanguageModelV3Message[]) => Promise<string>;
  model?: LanguageModel;
}

export interface LlmSummarizerFormattingOptions {
  maxTranscriptChars?: number;
  maxPartChars?: number;
  deterministicSummaryMaxChars?: number;
}

export interface LlmSummarizerOptions {
  model: LanguageModel;
}

export interface CompactionStoreKey {
  conversationId: string;
  agentId: string;
}

export interface CompactionAnchor {
  sourceRecordId?: string;
  eventId?: string;
  messageId?: string;
}

export interface CompactionEdit {
  id: string;
  source: "manual" | "auto";
  start: CompactionAnchor;
  end: CompactionAnchor;
  replacement: string;
  createdAt: number;
  compactedMessageCount: number;
  steeringMessage?: string;
  fromText?: string;
  toText?: string;
}

export interface CompactionState {
  edits: CompactionEdit[];
  updatedAt?: number;
  agentLabel?: string;
}

export interface CompactionStore {
  get(key: CompactionStoreKey): Promise<CompactionState | undefined> | CompactionState | undefined;
  set(key: CompactionStoreKey, state: CompactionState): Promise<void> | void;
}

export interface CompactionToolInput {
  guidance?: string;
  from?: string;
  to?: string;
}

export type CompactionToolResult =
  | {
    ok: true;
    queuedEditId: string;
    compactedMessageCount: number;
    fromText?: string;
    toText?: string;
  }
  | {
    ok: false;
    error: string;
  };

export interface CompactionShouldCompactArgs {
  state: ContextManagementStrategyState;
  prompt: LanguageModelV3Prompt;
}

export interface CompactionOnCompactArgs {
  state: ContextManagementStrategyState;
  prompt: LanguageModelV3Prompt;
  messages: LanguageModelV3Message[];
  requestContext: ContextManagementRequestContext;
  mode: "manual" | "auto";
  steeringMessage?: string;
}

export interface CompactionToolStrategyOptions {
  shouldCompact?: (
    args: CompactionShouldCompactArgs
  ) => Promise<boolean> | boolean;
  onCompact?: (
    args: CompactionOnCompactArgs
  ) => Promise<string> | string;
  preserveRecentMessages?: number;
  compactionStore?: CompactionStore;
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
  headCount?: number;
  keepLastMessages?: number;
  maxPromptTokens?: number;
  estimator?: PromptTokenEstimator;
}

export interface ScratchpadStoreKey {
  conversationId: string;
  agentId: string;
}

export interface ScratchpadState {
  entries?: Record<string, string>;
  preserveTurns?: number | null;
  activeNotice?: ScratchpadUseNotice;
  updatedAt?: number;
  agentLabel?: string;
}

export interface ScratchpadUseNotice {
  description: string;
  toolCallId: string;
  rawTurnCountAtCall: number;
  projectedTurnCountAtCall: number;
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
  emptyStateGuidance?: string | string[];
  budgetProfile?: ContextBudgetProfile;
  forceToolThresholdRatio?: number;
}

export interface ScratchpadToolInput {
  description: string;
  setEntries?: Record<string, string>;
  replaceEntries?: Record<string, string>;
  removeEntryKeys?: string[];
  preserveTurns?: number | null;
}

export type ScratchpadToolResult =
  | { ok: true }
  | { ok: false; error: string };

export interface SlidingWindowStrategyPayload {
  kind: "sliding-window";
  headCount: number;
  keepLastMessages: number;
  maxPromptTokens?: number;
  messagesRemoved: number;
}

export interface ToolResultDecayStrategyPayload {
  kind: "tool-result-decay";
  currentPromptTokens: number;
  maxResultTokens: number;
  placeholderMinSourceTokens: number;
  pressureAnchors: ToolResultDecayPressureAnchor[];
  warningForecastExtraTokens: number;
  toolContextTokens?: number;
  depthFactor?: number;
  forecastToolContextTokens?: number;
  forecastDepthFactor?: number;
  placeholderCount?: number;
  inputPlaceholderCount?: number;
  totalToolExchanges?: number;
  warningCount?: number;
  warningToolCallIds?: string[];
  warningPlaceholderIds?: string[];
}

export interface ScratchpadStrategyPayload {
  kind: "scratchpad";
  entryCount: number;
  entryCharCount: number;
  preserveTurns?: number | null;
  activeNoticeDescription?: string;
  activeNoticeToolCallId?: string;
  activeNoticeRawTurnCountAtCall?: number;
  activeNoticeProjectedTurnCountAtCall?: number;
  otherScratchpadCount: number;
  estimatedTokens: number;
  forceToolThresholdRatio?: number;
  forceThresholdTokens?: number;
  forcedToolChoice: boolean;
  latestToolName?: string;
}

export interface SummarizationStrategyPayload {
  kind: "summarization";
  estimatedTokens: number;
  preserveRecentMessages: number;
  preservedMessageCount?: number;
  messagesSummarizedCount?: number;
  summaryCharCount?: number;
}

export interface RemindersStrategyPayload {
  kind: "reminders";
  providerCount: number;
  builtInCount: number;
  emittedCount: number;
  deferredCount: number;
  overlayCount: number;
  latestUserAppendCount: number;
  fallbackSystemCount: number;
  reminderTypes: string[];
}

export interface AnthropicPromptCachingStrategyPayload {
  kind: "anthropic-prompt-caching";
  sharedPrefixMessageCount: number;
  lastSharedMessageIndex?: number;
  breakpointApplied: boolean;
  clearToolUsesEnabled: boolean;
}

export interface CompactionToolStrategyPayload {
  kind: "compaction-tool";
  mode: "manual" | "auto" | "stored";
  editCount: number;
  compactedMessageCount: number;
  fromIndex?: number;
  toIndex?: number;
  summaryCharCount: number;
}

export interface PinnedMessagesStrategyPayload {
  kind: "pinned-messages";
  pinnedToolCallIds: string[];
  maxPinned: number;
}

export interface CustomStrategyPayload {
  kind: "custom";
  strategyName: string;
  payload: Record<string, unknown>;
}

export type ContextManagementStrategyPayload =
  | SlidingWindowStrategyPayload
  | ToolResultDecayStrategyPayload
  | ScratchpadStrategyPayload
  | SummarizationStrategyPayload
  | RemindersStrategyPayload
  | AnthropicPromptCachingStrategyPayload
  | CompactionToolStrategyPayload
  | PinnedMessagesStrategyPayload
  | CustomStrategyPayload;
