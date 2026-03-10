import type { LanguageModelV3Message } from "@ai-sdk/provider";

/**
 * Token estimation interface. Pluggable to support different estimators
 * (e.g., tiktoken for accuracy, char-based for speed).
 */
export interface TokenEstimator {
  /** Estimate token count for a single message */
  estimateMessage(message: LanguageModelV3Message): number;
  /** Estimate token count for an array of messages */
  estimateMessages(messages: LanguageModelV3Message[]): number;
  /** Estimate token count for a string */
  estimateString(text: string): number;
}

/**
 * LLM-assisted compressor interface.
 * Takes conversation messages and a target token count,
 * returns a compressed single-message summary.
 */
export interface LLMCompressor {
  compress(
    messages: LanguageModelV3Message[],
    targetTokens: number,
    options?: {
      systemPrompt?: string;
    }
  ): Promise<LanguageModelV3Message[]>;
}

/**
 * Compression cache interface. Uses LRU eviction by default.
 */
export interface CompressionCache {
  get(key: string): CompressionResult | undefined;
  set(key: string, value: CompressionResult): void;
  clear(): void;
  size: number;
}

/**
 * Result of a compression operation, stored in cache.
 */
export interface CompressionResult {
  messages: LanguageModelV3Message[];
  tier: CompressionTier;
  modifications: CompressionModification[];
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
}

export type CompressionTier = "none" | "rule-based" | "llm-assisted";

/**
 * Record of a single modification made during compression.
 */
export interface CompressionModification {
  type: "tool-output-truncated" | "tool-output-removed" | "message-removed" | "conversation-summarized";
  messageIndex: number;
  originalTokens: number;
  compressedTokens: number;
  toolName?: string;
}

/**
 * Per-tool output compression policy.
 * - "keep": Don't compress this tool's output
 * - "truncate": Shorten to maxTokens with truncation marker
 * - "remove": Replace with "[Tool output removed for brevity]"
 */
export type ToolOutputPolicy = "keep" | "truncate" | "remove";

/**
 * Tool output compression configuration.
 */
export interface ToolOutputConfig {
  /** Default policy for tool outputs not explicitly overridden */
  defaultPolicy?: ToolOutputPolicy;
  /** Maximum tokens for truncated tool outputs */
  maxTokens?: number;
  /** Number of most recent tool outputs to keep at full fidelity */
  recentFullCount?: number;
  /** Per-tool policy overrides keyed by tool name */
  toolOverrides?: Record<string, ToolOutputPolicy>;
}

/**
 * Debug info emitted via onDebug callback after each compression.
 */
export interface ContextDebugInfo {
  tier: CompressionTier;
  originalMessageCount: number;
  compressedMessageCount: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  modifications: CompressionModification[];
  cacheHit: boolean;
  compressionTimeMs: number;
}

/**
 * Main configuration for the context management middleware.
 */
export interface ContextManagementConfig {
  /**
   * Maximum token budget for the entire prompt (system + conversation).
   * This should match your model's context window size.
   */
  maxTokens: number;

  /**
   * Utilization threshold (0-1) above which rule-based compression activates.
   * Default: 0.8 (80%)
   */
  ruleBasedThreshold?: number;

  /**
   * Utilization threshold (0-1) above which LLM-assisted compression activates.
   * Only triggers if rule-based compression was insufficient.
   * Default: 0.95 (95%)
   */
  llmThreshold?: number;

  /**
   * Number of most recent messages to protect from any compression.
   * Default: 4
   */
  protectedTailCount?: number;

  /** Token estimator implementation. Uses default char-based estimator if not provided. */
  estimator?: TokenEstimator;

  /** LLM compressor for Tier 2. If not provided, only rule-based compression is available. */
  llmCompressor?: LLMCompressor;

  /** Compression cache. If not provided, no caching. */
  cache?: CompressionCache;

  /** Tool output compression configuration */
  toolOutput?: ToolOutputConfig;

  /** Debug callback invoked after each compression */
  onDebug?: (info: ContextDebugInfo) => void;
}
