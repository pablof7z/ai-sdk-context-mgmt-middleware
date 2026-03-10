import type { LanguageModelV3Message, LanguageModelV3Middleware } from "@ai-sdk/provider";

export type ContextRole = "system" | "user" | "assistant" | "tool";
export type ContextEntryType = "text" | "tool-call" | "tool-result" | "summary";
export type ToolEntryType = "tool-call" | "tool-result";
export type ToolOutputPolicy = "keep" | "truncate" | "remove";

export interface ContextMessageInput {
  id?: string;
  role: ContextRole;
  content: string;
  entryType?: ContextEntryType;
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
  attributes?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ContextMessage extends ContextMessageInput {
  id: string;
  entryType: ContextEntryType;
}

export interface CompressionSegment {
  fromId: string;
  toId: string;
  compressed: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TranscriptRenderResult {
  text: string;
  shortIdMap: Map<string, string>;
  firstId: string | null;
  lastId: string | null;
}

export interface TranscriptRenderOptions {
  shortIdLength?: number;
}

export interface TranscriptRenderer {
  render(messages: ContextMessage[], options?: TranscriptRenderOptions): TranscriptRenderResult;
}

export interface TokenEstimator {
  estimateMessage(message: ContextMessage): number;
  estimateMessages(messages: ContextMessage[]): number;
  estimateString(text: string): number;
}

export interface CompressionCache<T = ManageContextResult> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  readonly size: number;
}

export interface ToolPolicyEntryContext {
  message: ContextMessage;
  messageIndex: number;
  positionFromEnd: number;
  tokens: number;
  content: string;
}

export interface ToolEntryPolicyDecision {
  policy: ToolOutputPolicy;
  maxTokens?: number;
}

export interface ToolPolicyDecision {
  call?: ToolEntryPolicyDecision;
  result?: ToolEntryPolicyDecision;
}

export interface ToolPolicyContext {
  toolName: string;
  toolCallId?: string;
  call?: ToolPolicyEntryContext;
  result?: ToolPolicyEntryContext;
  exchangePositionFromEnd: number;
  combinedTokens: number;
  currentTokenEstimate: number;
  maxContextTokens: number;
  messages: readonly ContextMessage[];
}

export type ToolPolicy = (
  context: ToolPolicyContext
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;

export interface ToolContentTruncationEvent {
  entryType: ToolEntryType;
  toolName: string;
  toolCallId?: string;
  messageIndex: number;
  originalContent: string;
  originalTokens: number;
  removed: boolean;
}

export interface CompressionModification {
  type:
    | "tool-call-truncated"
    | "tool-call-removed"
    | "tool-result-truncated"
    | "tool-result-removed"
    | "message-removed"
    | "conversation-summarized";
  messageIndex: number;
  originalTokens: number;
  compressedTokens: number;
  toolName?: string;
  toolCallId?: string;
  originalText?: string;
}

export interface SegmentGenerationInput {
  transcript: TranscriptRenderResult;
  targetTokens: number;
  messages: ContextMessage[];
  previousSegments: CompressionSegment[];
}

export interface SegmentGenerator {
  generate(input: SegmentGenerationInput): Promise<CompressionSegment[]>;
}

export interface SegmentValidationOptions {
  requireFullCoverage?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface ManageContextStats {
  originalTokenEstimate: number;
  postToolPolicyTokenEstimate: number;
  postSegmentTokenEstimate: number;
  finalTokenEstimate: number;
}

export interface ManageContextResult {
  messages: ContextMessage[];
  appliedSegments: CompressionSegment[];
  newSegments: CompressionSegment[];
  modifications: CompressionModification[];
  stats: ManageContextStats;
}

export interface ManageContextConfig {
  messages: ContextMessageInput[];
  maxTokens: number;
  compressionThreshold?: number;
  protectedTailCount?: number;
  estimator?: TokenEstimator;
  segmentGenerator?: SegmentGenerator;
  transcriptRenderer?: TranscriptRenderer;
  existingSegments?: CompressionSegment[];
  toolPolicy?: ToolPolicy;
  onToolContentTruncated?: (
    event: ToolContentTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>;
  onToolOutputTruncated?: (
    event: ToolContentTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>;
}

export interface ContextDebugInfo {
  originalMessageCount: number;
  compressedMessageCount: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  modifications: CompressionModification[];
  appliedSegments: CompressionSegment[];
  newSegments: CompressionSegment[];
  cacheHit: boolean;
  compressionTimeMs: number;
}

export interface SegmentStore {
  load(conversationKey: string): Promise<CompressionSegment[] | undefined> | CompressionSegment[] | undefined;
  save?(conversationKey: string, segments: CompressionSegment[]): Promise<void> | void;
  append?(conversationKey: string, segments: CompressionSegment[]): Promise<void> | void;
}

export interface MiddlewareContext {
  params: Record<string, unknown> & { prompt?: LanguageModelV3Message[] };
  type: string;
  model: {
    provider: string;
    modelId: string;
  };
}

export interface ContextManagementConfig {
  maxTokens: number;
  compressionThreshold?: number;
  protectedTailCount?: number;
  estimator?: TokenEstimator;
  segmentGenerator?: SegmentGenerator;
  transcriptRenderer?: TranscriptRenderer;
  segmentStore?: SegmentStore;
  resolveConversationKey?: (context: MiddlewareContext) => string;
  cache?: CompressionCache<ManageContextResult>;
  toolPolicy?: ToolPolicy;
  onDebug?: (info: ContextDebugInfo) => void;
  onToolContentTruncated?: (
    event: ToolContentTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>;
  onToolOutputTruncated?: (
    event: ToolContentTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>;
}

export type ContextManagementMiddleware = LanguageModelV3Middleware;
