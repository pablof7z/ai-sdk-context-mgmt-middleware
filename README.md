# ai-sdk-context-management

Context management for AI SDK agents: prompt-rewriting middleware, optional agent tools, and structured telemetry.

Every agent eventually runs into the same problem: the next model call cannot see everything.

That makes context management less of a storage problem than a selection problem:

- what stays verbatim
- what gets compressed
- what can be dropped
- what should remain stable for prompt caching
- when the model should manage its own future context

`ai-sdk-context-management` gives you a concrete answer inside the AI SDK. It does not replace your thread store or agent loop. It sits at the model boundary and rewrites the provider prompt before each call.

## What This Package Does

- composes context-management strategies as AI SDK middleware
- optionally exposes tools such as `scratchpad`, `pin_tool_result`, and `compact_context`
- emits telemetry for every decision so hosts can inspect what changed and why
- keeps the host in control of persistence, storage, and policy

## Design Principles

- Stable prefixes are cheaper. System instructions should stay ordered and cache-friendly.
- Tool observations age faster than reasoning. Old tool payloads are usually better candidates for truncation, masking, or summarization than the surrounding decision trail.
- Recent context is more valuable than exhaustive context. The last few turns usually matter more than a perfect transcript.
- Agents sometimes need agency over their own context. A model should be able to leave notes, protect important results, or request compaction.
- Context management should be inspectable. If the runtime drops or rewrites context, the host should be able to see that explicitly.

## Installation

```bash
npm install ai @ai-sdk/provider ai-sdk-context-management
```

## How It Works

1. You create a runtime with one or more strategies.
2. You wrap your AI SDK model with the runtime middleware.
3. Before each model call, the runtime reads request-scoped context and runs strategies in order.
4. Some strategies also expose tools the agent can call to manage future turns.
5. The runtime emits telemetry describing what changed.

The package is deliberately narrow: it manages the prompt you send to the model. It does not own your database, vector store, conversation history, or orchestration layer.

## Quick Start

```ts
import { generateText, wrapLanguageModel } from "ai";
import {
  ContextUtilizationReminderStrategy,
  LLMSummarizationStrategy,
  ScratchpadStrategy,
  type ScratchpadState,
  SystemPromptCachingStrategy,
  ToolResultDecayStrategy,
  createContextManagementRuntime,
  createDefaultPromptTokenEstimator,
} from "ai-sdk-context-management";

const estimator = createDefaultPromptTokenEstimator();
const scratchpads = new Map<string, ScratchpadState>();

const runtime = createContextManagementRuntime({
  strategies: [
    new SystemPromptCachingStrategy(),
    new ToolResultDecayStrategy({
      maxPromptTokens: 24_000,
      estimator,
    }),
    new LLMSummarizationStrategy({
      model: summarizerModel,
      maxPromptTokens: 36_000,
      estimator,
    }),
    new ScratchpadStrategy({
      scratchpadStore: {
        get: ({ conversationId, agentId }) =>
          scratchpads.get(`${conversationId}:${agentId}`),
        set: ({ conversationId, agentId }, state) => {
          scratchpads.set(`${conversationId}:${agentId}`, state);
        },
        listConversation: (conversationId) =>
          [...scratchpads.entries()]
            .filter(([key]) => key.startsWith(`${conversationId}:`))
            .map(([key, state]) => ({
              agentId: key.split(":")[1],
              agentLabel: state.agentLabel,
              state,
            })),
      },
      reminderTone: "informational",
    }),
    new ContextUtilizationReminderStrategy({
      workingTokenBudget: 40_000,
      warningThresholdRatio: 0.7,
      mode: "scratchpad",
      estimator,
    }),
  ],
  estimator,
  telemetry: async (event) => {
    console.log("[context-management]", event.type, event);
  },
});

const model = wrapLanguageModel({
  model: baseModel,
  middleware: runtime.middleware,
});

const requestContext = {
  contextManagement: {
    conversationId: "conv-123",
    agentId: "agent-456",
    agentLabel: "Researcher",
  },
};

const result = await generateText({
  model,
  messages,
  tools: {
    ...agentTools,
    ...runtime.optionalTools,
  },
  providerOptions: requestContext,
  experimental_context: requestContext,
});
```

`baseModel`, `summarizerModel`, `messages`, and `agentTools` come from your application. The key integration points are the wrapped model, `runtime.optionalTools`, and the shared `contextManagement` object passed to both `providerOptions` and `experimental_context`.

That stack applies four practical heuristics:

- keep system messages stable for caching
- decay old tool results before touching the rest of the conversation
- summarize only when the prompt crosses a budget
- let the agent preserve notes for future turns

## Request Context Contract

The middleware reads `providerOptions.contextManagement`.

Optional tools read `experimental_context.contextManagement`.

Both must contain the same request-scoped identity:

```ts
{
  conversationId: string;
  agentId: string;
  agentLabel?: string;
}
```

If that context is missing, the middleware becomes a no-op and context-management tools will reject execution.

## Choosing a Strategy Stack

Use the simplest stack that matches the behavior you need.

### Short or bounded conversations

- `SlidingWindowStrategy`
- `HeadAndTailStrategy`

### Tool-heavy agents

- `SystemPromptCachingStrategy`
- `ToolResultDecayStrategy`

### Long-running agents

- `SystemPromptCachingStrategy`
- `PinnedMessagesStrategy`
- `ToolResultDecayStrategy`
- `LLMSummarizationStrategy`

### Agents that manage their own context

- `SystemPromptCachingStrategy`
- `PinnedMessagesStrategy`
- `ScratchpadStrategy`
- `CompactionToolStrategy`

### Long-running multi-agent systems

- `SystemPromptCachingStrategy`
- `PinnedMessagesStrategy`
- `ToolResultDecayStrategy`
- `ScratchpadStrategy`
- `ContextUtilizationReminderStrategy`

## Strategy Ordering

Strategies run in array order. A good default is:

1. `SystemPromptCachingStrategy`
2. `PinnedMessagesStrategy`
3. pruning and compression strategies
4. agent-directed context tools and reminders

In practice that usually means:

1. `SystemPromptCachingStrategy`
2. `PinnedMessagesStrategy`
3. `SlidingWindowStrategy`, `HeadAndTailStrategy`, `ToolResultDecayStrategy`, `SummarizationStrategy`, or `LLMSummarizationStrategy`
4. `ScratchpadStrategy` or `CompactionToolStrategy`
5. `ContextUtilizationReminderStrategy`

## Strategy Guide

### `SystemPromptCachingStrategy`

Normalizes the prompt so system messages form a stable prefix. This is the cheapest way to improve cache behavior and reduce prompt churn.

Main option:

- `consolidateSystemMessages`: merge multiple non-context-management system messages into one

### `SlidingWindowStrategy`

Keeps the last `N` non-system messages and drops older history. This is the simplest bounded-context policy.

Main options:

- `keepLastMessages`
- `maxPromptTokens`

### `HeadAndTailStrategy`

Keeps the beginning and the end of the conversation while dropping the middle. Useful when setup context matters and recent turns matter, but the middle has gone stale.

Main options:

- `headCount`
- `tailCount`

### `ToolResultDecayStrategy`

Applies graduated compression to tool results:

- recent tool results stay raw
- medium-age tool results are truncated
- older tool results become placeholders

The tool-call structure stays intact, which preserves the reasoning chain while shrinking the heaviest payloads.

Main options:

- `keepFullResultCount`
- `truncateWindowCount`
- `truncatedMaxTokens`
- `maxPromptTokens`
- `placeholder`

### `SummarizationStrategy`

Summarizes older messages once the prompt crosses a token budget. You provide the summarizer function; the strategy handles boundary selection and prompt rewriting.

Main options:

- `summarize`
- `maxPromptTokens`
- `keepLastMessages`

Use this when you already have your own summarization path.

### `LLMSummarizationStrategy`

Wraps `SummarizationStrategy` with an AI SDK model-based summarizer. It also falls back to a deterministic compressed transcript if the LLM call fails or returns empty output.

Main options:

- `model`
- `providerOptions`
- `maxOutputTokens`
- `systemPrompt`
- `temperature`
- `formatting`
- `maxPromptTokens`
- `keepLastMessages`

### `PinnedMessagesStrategy`

Adds a `pin_tool_result` tool so the agent can protect specific `toolCallId`s from pruning. Pinned tool exchanges survive trimming, decay, summarization, scratchpad omission, and compaction boundaries.

Main options:

- `pinnedStore`
- `maxPinned`

Tool input:

```ts
{
  pin?: string[];
  unpin?: string[];
}
```

### `ScratchpadStrategy`

Adds a `scratchpad` tool so the agent can preserve notes and proactively shape future context. It can:

- store per-agent notes for the current conversation
- omit stale tool exchanges by `toolCallId`
- reduce the visible tail with `keepLastMessages`
- render other agents' scratchpads into the current turn with attribution
- optionally force a `scratchpad` tool call when the working budget gets tight

Main options:

- `scratchpadStore`
- `reminderTone`
- `workingTokenBudget`
- `forceToolThresholdRatio`

Tool input:

```ts
{
  notes?: string;
  keepLastMessages?: number | null;
  omitToolCallIds?: string[];
}
```

### `CompactionToolStrategy`

Adds a `compact_context` tool so the model can decide when older history should be compacted into a summary. This is useful when compaction should happen because of the agent's internal plan, not just because a token counter fired.

Main options:

- `summarize`
- `keepLastMessages`
- `compactionStore`

If you provide a `compactionStore`, the summary can be injected again on later turns for the same `conversationId` and `agentId`.

### `ContextUtilizationReminderStrategy`

Appends a warning block once the prompt crosses a configured fraction of a working budget. It does not compress context itself; it tells the model that it should act before the context becomes unusable.

Main options:

- `workingTokenBudget`
- `warningThresholdRatio`
- `mode`

## Runtime API

### `createContextManagementRuntime({ strategies, telemetry, estimator })`

Returns:

- `middleware`
- `optionalTools`

The runtime merges tools from all strategies and throws on tool-name collisions.

## Telemetry

The runtime can emit raw events for every request:

- `runtime-start`
- `strategy-complete`
- `tool-execute-start`
- `tool-execute-complete`
- `tool-execute-error`
- `runtime-complete`

These events include request context, before/after token estimates, removed-tool deltas, pinned-tool deltas, and prompt snapshots. The goal is to make context management observable instead of magical.

## Utilities

The package also exports helpers for hosts that want more control:

- `createDefaultPromptTokenEstimator`
- `createLlmSummarizer`
- `buildSummaryTranscript`
- `buildDeterministicSummary`
- `CONTEXT_MANAGEMENT_KEY`

## Examples

Runnable examples live in [`examples/`](./examples) with a short guide in [`examples/README.md`](./examples/README.md).

Included examples:

- sliding-window trimming
- tool-result decay
- summarization
- composed strategies

## Running Locally

```bash
bun test
bun run typecheck
bun run build
```
