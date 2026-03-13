# New Context Management Strategies

## Existing strategies

- `SlidingWindowStrategy` — drop oldest non-system messages, keep last N
- `ScratchpadStrategy` — agent-driven notes + selective tool omission via tool call

## New automatic strategies

### ToolResultDecayStrategy

Graduated compression of tool results by age. Recent results stay full, medium-age results get truncated, old results become placeholders. The reasoning chain (tool calls, text messages) stays intact — only tool result content is affected.

```ts
interface ToolResultDecayStrategyOptions {
  // Results in the last N tool exchanges stay untouched. Default: 3
  keepFullResultCount?: number;

  // Results older than keepFullResultCount get truncated to this many tokens. Default: 200
  truncatedMaxTokens?: number;

  // Results older than keepFullResultCount + truncateWindowCount become placeholders. Default: 5
  truncateWindowCount?: number;

  // Placeholder for fully decayed results. Default: "[result omitted]"
  placeholder?: string | ((toolName: string, toolCallId: string) => string);

  estimator?: PromptTokenEstimator;
}
```

Three zones: full → truncated → placeholder. Maps to Manus's graduated hierarchy and JetBrains's observation masking finding.

### HeadAndTailStrategy

Keep first N + last M non-system messages, drop the middle. Based on the "lost in the middle" research (Liu et al., 2024) showing LLM performance follows a U-shaped curve — best at beginning and end of context.

```ts
interface HeadAndTailStrategyOptions {
  // Non-system messages to keep from the start. Default: 2
  headCount?: number;

  // Non-system messages to keep from the end. Default: 8
  tailCount?: number;
}
```

Preserves tool-call/tool-result adjacency at both trim boundaries (same logic as SlidingWindowStrategy).

### SummarizationStrategy

When estimated token count exceeds a threshold, summarize older messages via a user-provided function, replace them with a single system message containing the summary.

```ts
interface SummarizationStrategyOptions {
  // User-provided summarizer. Receives messages to summarize, returns summary text.
  summarize: (messages: LanguageModelV3Message[]) => Promise<string>;

  // Trigger summarization when estimated tokens exceed this. Required.
  maxPromptTokens: number;

  // Never summarize the last N non-system messages. Default: 8
  keepLastMessages?: number;

  estimator?: PromptTokenEstimator;
}
```

The `summarize` function is deliberately opaque — users bring their own LLM call. The strategy handles everything else: identifying the summarizable block, replacing it with a system message, preserving the tail.

If a previous summary system message already exists (from a prior turn), it gets included in the messages passed to `summarize` so the summarizer can build on it rather than starting fresh.

### SystemPromptCachingStrategy

Reorders the prompt to maximize KV-cache hit rates. Stable content moves to the front, dynamic content stays at the end.

```ts
interface SystemPromptCachingStrategyOptions {
  // Consolidate multiple system messages into one. Default: true
  consolidateSystemMessages?: boolean;
}
```

Behavior:
- All system messages move to the front of the prompt (before any non-system messages)
- If `consolidateSystemMessages` is true, they're merged into a single system message
- Tool definitions in `params` are not reordered (they're already handled by the AI SDK)
- Non-system message order is never changed

This is minimal but addresses the core insight from Manus: prompt prefix stability is the single most important cost lever (10x on Anthropic, automatic on OpenAI).

Should run first in the strategy pipeline so other strategies operate on the normalized ordering.

## New agent-driven strategies

### CompactionToolStrategy

Gives the model a `compact_context` tool. When called, triggers LLM summarization of older messages and replaces them with a summary block. The model decides *when* to compact.

```ts
interface CompactionToolStrategyOptions {
  // User-provided summarizer, same signature as SummarizationStrategy.
  summarize: (messages: LanguageModelV3Message[]) => Promise<string>;

  // Never compact the last N non-system messages. Default: 8
  keepLastMessages?: number;

  // Store for persisting the summary across turns.
  // Without this, the summary only affects the current multi-step run.
  compactionStore?: CompactionStore;

  estimator?: PromptTokenEstimator;
}

interface CompactionStoreKey {
  conversationId: string;
  agentId: string;
}

interface CompactionStore {
  get(key: CompactionStoreKey): Promise<string | undefined> | string | undefined;
  set(key: CompactionStoreKey, summary: string): Promise<void> | void;
}
```

The tool takes no input — calling it means "compact now." The tool result returns the summary text so the model knows what was preserved.

On each `apply()`, if a stored summary exists, it gets injected as a system message before the conversation messages.

Key difference from SummarizationStrategy: automatic vs agent-initiated. SummarizationStrategy fires when a token threshold is crossed. CompactionToolStrategy fires when the model decides it's time. Better for agents that need full detail during some phases and can afford to lose it in others.

### PinnedMessagesStrategy

Gives the model a `pin_message` tool to protect specific messages from being pruned by other strategies.

```ts
interface PinnedMessagesStrategyOptions {
  // Store for persisting pinned message IDs across turns.
  pinnedStore: PinnedStore;

  // Maximum number of pinned messages per conversation. Default: 10
  maxPinned?: number;
}

interface PinnedStoreKey {
  conversationId: string;
  agentId: string;
}

interface PinnedStore {
  get(key: PinnedStoreKey): Promise<string[]> | string[];
  set(key: PinnedStoreKey, messageIds: string[]): Promise<void> | void;
}
```

Tool input:
```ts
{
  // Message IDs to pin (additive).
  pin?: string[];
  // Message IDs to unpin.
  unpin?: string[];
}
```

Implementation challenge: messages in `LanguageModelV3Prompt` don't have stable IDs. The strategy would need to either:
- Use message index (fragile across turns)
- Require the host to embed IDs in providerOptions per message
- Pin by tool call ID (only works for tool exchanges)

Pinning by `toolCallId` is the most practical — it composes directly with ToolResultDecayStrategy and SlidingWindowStrategy since those already track tool exchanges. The tool would be `pin_tool_result` rather than a generic `pin_message`.

Revised interface:
```ts
// Tool input
{
  pin?: string[];    // toolCallIds to protect
  unpin?: string[];  // toolCallIds to unprotect
}
```

Other strategies check `state.pinnedToolCallIds` (new field on ContextManagementStrategyState) before dropping tool exchanges.

## Composition patterns

Typical stacks users might configure:

**Simple agent (chatbot, support):**
`SlidingWindowStrategy`

**Tool-heavy agent (coding, research):**
`SystemPromptCachingStrategy` → `ToolResultDecayStrategy`

**Long-running agent with self-management:**
`SystemPromptCachingStrategy` → `ScratchpadStrategy`

**Long-running with safety nets:**
`SystemPromptCachingStrategy` → `ToolResultDecayStrategy` → `ScratchpadStrategy`

**Agent that controls its own compaction:**
`SystemPromptCachingStrategy` → `CompactionToolStrategy` → `PinnedMessagesStrategy`

**Maximum automatic management:**
`SystemPromptCachingStrategy` → `HeadAndTailStrategy` → `SummarizationStrategy`

## Strategy ordering contract

Strategies run in array order. Recommended ordering:

1. `SystemPromptCachingStrategy` (normalize prompt layout)
2. Pruning strategies (`SlidingWindow`, `HeadAndTail`, `ToolResultDecay`)
3. Agent-driven strategies (`Scratchpad`, `CompactionTool`, `PinnedMessages`)

PinnedMessagesStrategy is special — it needs to mark protected messages *before* pruning strategies run, so it should actually run first after SystemPromptCaching. This means it populates `state.pinnedToolCallIds` early, and pruning strategies check that set.

Revised ordering:
1. `SystemPromptCachingStrategy`
2. `PinnedMessagesStrategy` (mark protected messages)
3. Pruning strategies
4. Agent-driven strategies that inject content (Scratchpad, CompactionTool)

## GitHub issues for future consideration

- **FileOffloadStrategy** — `save_to_file` / `recall_from_file` tool pair, file system as extended memory (Manus pattern)
- **ErrorRetentionStrategy** — automatically protect failed tool results from compression, with user-provided `isError` predicate and convention-based defaults
