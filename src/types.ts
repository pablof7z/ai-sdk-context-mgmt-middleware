import type { LanguageModelV3Message, LanguageModelV3Middleware } from "@ai-sdk/provider";

export type ContextRole = "system" | "user" | "assistant" | "tool";
export type ContextEntryType = "text" | "tool-call" | "tool-result" | "summary";

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

export type ToolOutputPolicy = "keep" | "truncate" | "remove";

export interface ToolOutputConfig {
  defaultPolicy?: ToolOutputPolicy;
  maxTokens?: number;
  recentFullCount?: number;
  toolOverrides?: Record<string, ToolOutputPolicy>;
}

export interface ToolOutputTruncationEvent {
  toolName: string;
  toolCallId?: string;
  messageIndex: number;
  originalOutput: string;
  originalTokens: number;
  removed: boolean;
}

export interface CompressionModification {
  type: "tool-output-truncated" | "tool-output-removed" | "message-removed" | "conversation-summarized";
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
  toolOutput?: ToolOutputConfig;
  onToolOutputTruncated?: (
    event: ToolOutputTruncationEvent
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
  toolOutput?: ToolOutputConfig;
  onDebug?: (info: ContextDebugInfo) => void;
  onToolOutputTruncated?: (
    event: ToolOutputTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>;
}

export type ContextManagementMiddleware = LanguageModelV3Middleware;
