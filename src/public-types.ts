import type {
  CompressionCache,
  CompressionModification,
  ContextCompressionDebugInfo,
  ContextCompressionMessage,
  ContextCompressionStats,
  ContextEntryType,
  ContextRole,
  TokenEstimator,
  ToolContentTruncationEvent,
  ToolEntryPolicyDecision,
  ToolPolicy,
  ToolPolicyContext,
  ToolPolicyDecision,
  ToolPolicyEntryContext,
} from "./types.js";

export type ConversationRecordKind = ContextEntryType;
export type ConversationRecordRole = ContextRole;

export interface ConversationRecord {
  id: string;
  role: ConversationRecordRole;
  kind: ConversationRecordKind;
  content: string;
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
  attributes?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface SummarySpan {
  startRecordId: string;
  endRecordId: string;
  summary: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export type PromptMessage = ContextCompressionMessage;

export interface TranscriptBuildResult {
  text: string;
  shortIdMap: Map<string, string>;
  firstTranscriptId: string | null;
  lastTranscriptId: string | null;
}

export interface TranscriptBuildOptions {
  shortIdLength?: number;
}

export interface TranscriptBuilder {
  build(records: ConversationRecord[], options?: TranscriptBuildOptions): TranscriptBuildResult;
}

export interface SummarizerInput {
  transcript: TranscriptBuildResult;
  targetTokens: number;
  records: ConversationRecord[];
  previousSummarySpans: SummarySpan[];
}

export interface Summarizer {
  summarize(input: SummarizerInput): Promise<SummarySpan[]>;
}

export interface SummaryStore {
  load(conversationKey: string): Promise<SummarySpan[] | undefined> | SummarySpan[] | undefined;
  save?(conversationKey: string, summarySpans: SummarySpan[]): Promise<void> | void;
  append?(conversationKey: string, summarySpans: SummarySpan[]): Promise<void> | void;
}

export type SummaryFailureMode = "throw" | "last-resort-truncate";

export interface SummarizeConversationConfig {
  records: ConversationRecord[];
  maxTokens: number;
  summaryThreshold?: number;
  preservedTailCount?: number;
  estimator?: TokenEstimator;
  summarizer?: Summarizer;
  transcriptBuilder?: TranscriptBuilder;
  existingSummarySpans?: SummarySpan[];
  summaryStore?: SummaryStore;
  conversationKey?: string;
  summaryFailureMode?: SummaryFailureMode;
  onDebug?: (info: ContextCompressionDebugInfo) => void;
}

export interface SummarizeConversationResult {
  records: ConversationRecord[];
  appliedSummarySpans: SummarySpan[];
  newSummarySpans: SummarySpan[];
  modifications: CompressionModification[];
  stats: ContextCompressionStats;
}

export interface PrunePromptConfig {
  messages: PromptMessage[];
  maxTokens: number;
  pruningThreshold?: number;
  preservedTailCount?: number;
  priorContextTokens?: number;
  estimator?: TokenEstimator;
  existingSummarySpans?: SummarySpan[];
  summaryStore?: SummaryStore;
  conversationKey?: string;
  cache?: CompressionCache<PrunePromptResult>;
  promptToolPolicy?: PromptToolPolicy;
  retrievalToolName?: string;
  retrievalToolArgName?: string;
  onDebug?: (info: ContextCompressionDebugInfo) => void;
}

export interface PrunePromptResult {
  messages: PromptMessage[];
  appliedSummarySpans: SummarySpan[];
  newSummarySpans: SummarySpan[];
  modifications: CompressionModification[];
  stats: ContextCompressionStats;
}

export type PromptPruningDebugInfo = ContextCompressionDebugInfo;
export type PromptToolPolicy = ToolPolicy;
export type PromptToolPolicyContext = ToolPolicyContext;
export type PromptToolPolicyDecision = ToolPolicyDecision;
export type PromptToolPolicyEntryContext = ToolPolicyEntryContext;
export type PromptToolEntryDecision = ToolEntryPolicyDecision;
export type PromptToolTruncationEvent = ToolContentTruncationEvent;
