# ai-sdk-context-management

Context management for AI SDK agents: prompt-rewriting middleware, optional agent tools, and structured telemetry.

Every agent eventually runs into the same problem: the next model call cannot see everything. Context management is the policy that decides:

- what stays verbatim
- what gets compressed
- what can be dropped
- what should stay stable for prompt caching
- when the agent should manage its own future context

`ai-sdk-context-management` sits at the model boundary. It does not replace your thread store or orchestrator. It rewrites the provider prompt before each call and exposes optional tools that let the agent shape later turns.

## Installation

```bash
npm install ai @ai-sdk/provider ai-sdk-context-management
```

## Quick Start

The minimum integration is small:

```ts
import { generateText, wrapLanguageModel } from "ai";
import {
  ToolResultDecayStrategy,
  createContextManagementRuntime,
} from "ai-sdk-context-management";

const contextManagement = {
  conversationId: "conv-123",
  agentId: "agent-456",
};

const runtime = createContextManagementRuntime({
  strategies: [new ToolResultDecayStrategy({ maxPromptTokens: 24_000 })],
});

const model = wrapLanguageModel({
  model: baseModel,
  middleware: runtime.middleware,
});

const result = await generateText({
  model,
  messages,
  tools: {
    ...agentTools,
    ...runtime.optionalTools,
  },
  providerOptions: { contextManagement },
  experimental_context: { contextManagement },
});
```

That is the core contract:

- wrap the model with `runtime.middleware`
- merge in `runtime.optionalTools` if you use tool-emitting strategies
- pass the same `contextManagement` object to both `providerOptions` and `experimental_context`

If you want the full stack version with telemetry, summarization, scratchpad, and reminders, run [`examples/04-composed-strategies.ts`](./examples/04-composed-strategies.ts).

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

## Strategy Index

Per-strategy docs live in [`src/strategies/`](./src/strategies/README.md).

| Strategy | What changes in the prompt | What the agent gets | Docs | Runnable example |
| --- | --- | --- | --- | --- |
| `SystemPromptCachingStrategy` | Moves system messages into a stable prefix and can consolidate them | Better cache reuse and less prompt churn | [docs](./src/strategies/system-prompt-caching/README.md) | [06-system-prompt-caching.ts](./examples/06-system-prompt-caching.ts) |
| `SlidingWindowStrategy` | Keeps the recent tail, can optionally preserve a head, and drops older non-system turns | Bounded context with simple recency bias or setup preservation | [docs](./src/strategies/sliding-window/README.md) | [01-sliding-window.ts](./examples/01-sliding-window.ts) |
| `ToolResultDecayStrategy` | Leaves recent tool results raw, then decays them based on depth and total tool-context pressure | Keeps the reasoning chain while shrinking the heaviest payloads only when tool usage actually grows | [docs](./src/strategies/tool-result-decay/README.md) | [02-tool-result-decay.ts](./examples/02-tool-result-decay.ts) |
| `SummarizationStrategy` | Replaces older turns with a tagged summary block using either `summarize(...)` or `model` | Older facts survive in compressed form without replaying the whole middle | [docs](./src/strategies/summarization/README.md) | [03-summarization.ts](./examples/03-summarization.ts), [07-model-backed-summarization.ts](./examples/07-model-backed-summarization.ts) |
| `ScratchpadStrategy` | Injects persisted scratchpad state and can remove stale tool exchanges | Structured working state, note edits, and selective forgetting | [docs](./src/strategies/scratchpad/README.md) | [08-scratchpad.ts](./examples/08-scratchpad.ts) |
| `PinnedMessagesStrategy` | Marks specific tool call IDs as protected before pruning | Lets the agent keep the evidence it considers critical | [docs](./src/strategies/pinned-messages/README.md) | [09-pinned-messages.ts](./examples/09-pinned-messages.ts) |
| `CompactionToolStrategy` | Compacts old history only after the agent asks for it | Agent-controlled compression at task boundaries | [docs](./src/strategies/compaction-tool/README.md) | [10-compaction-tool.ts](./examples/10-compaction-tool.ts) |
| `ContextUtilizationReminderStrategy` | Appends a warning block when the prompt gets tight | Gives the agent time to summarize or compact before failure | [docs](./src/strategies/context-utilization-reminder/README.md) | [11-context-utilization-reminder.ts](./examples/11-context-utilization-reminder.ts) |
| `ContextWindowStatusStrategy` | Appends a compact token-usage status block to the latest user turn | Gives the agent explicit working-budget and raw-window visibility | [docs](./src/strategies/context-window-status/README.md) | n/a |

## Strategy Ordering

Strategies run in array order. A good default is:

1. `SystemPromptCachingStrategy`
2. `PinnedMessagesStrategy`
3. pruning and compression strategies
4. agent-directed context tools
5. reminder strategies

In practice that usually means:

1. `SystemPromptCachingStrategy`
2. `PinnedMessagesStrategy`
3. `SlidingWindowStrategy` (optionally with `headCount`), `ToolResultDecayStrategy`, or `SummarizationStrategy`
4. `ScratchpadStrategy` or `CompactionToolStrategy`
5. `ContextUtilizationReminderStrategy`

## Choosing A Stack

- Short, bounded conversations: `SlidingWindowStrategy`
- Preserve setup plus the latest turns: `SlidingWindowStrategy({ headCount, keepLastMessages })`
- Tool-heavy agents: `SystemPromptCachingStrategy` + `ToolResultDecayStrategy`
- Long-running agents: `SystemPromptCachingStrategy` + `PinnedMessagesStrategy` + `ToolResultDecayStrategy` + `SummarizationStrategy({ model })`
- Agents that self-manage context: `SystemPromptCachingStrategy` + `PinnedMessagesStrategy` + `ScratchpadStrategy` + `CompactionToolStrategy`
- Full graduated stack: run [`examples/04-composed-strategies.ts`](./examples/04-composed-strategies.ts)

## Tool Result Decay

`ToolResultDecayStrategy` now decays tool context using:

- `effectiveDepth = depth * pressureFactor(toolContextTokens)`
- default pressure anchors:
  - `100 -> 0.05`
  - `5_000 -> 1`
  - `50_000 -> 5`

That means low-token tool usage can remain intact for many turns, while heavy tool sessions decay aggressively much earlier.

You can tune the curve with `pressureAnchors` and the warning forecast with `warningForecastExtraTokens`:

```ts
new ToolResultDecayStrategy({
  pressureAnchors: [
    { toolTokens: 100, depthFactor: 0.05 },
    { toolTokens: 5_000, depthFactor: 1 },
    { toolTokens: 50_000, depthFactor: 5 },
  ],
  warningForecastExtraTokens: 10_000,
});
```

Warnings are emitted through the reminder sink with machine-readable attributes:

- `tool_call_ids`
- `truncate_ids`
- `placeholder_ids`
- `forecast_extra_tool_tokens`
- `forecast_tool_context_tokens`

## Runnable Examples

All examples are local and deterministic. They use mock models, print the transformed prompt, and show exactly what is interesting about the output.

| Example | Run | What to look for |
| --- | --- | --- |
| [01-sliding-window.ts](./examples/01-sliding-window.ts) | `cd examples && npx tsx 01-sliding-window.ts` | The oldest exchange disappears, so the model only sees the recent tail |
| [02-tool-result-decay.ts](./examples/02-tool-result-decay.ts) | `cd examples && npx tsx 02-tool-result-decay.ts` | Pressure-aware decay keeps light tool history longer, then truncates and placeholders older heavy results |
| [03-summarization.ts](./examples/03-summarization.ts) | `cd examples && npx tsx 03-summarization.ts` | A tagged summary system message replaces older turns |
| [04-composed-strategies.ts](./examples/04-composed-strategies.ts) | `cd examples && npx tsx 04-composed-strategies.ts` | Multiple strategies stack cleanly and telemetry shows what ran |
| [05-sliding-window-head.ts](./examples/05-sliding-window-head.ts) | `cd examples && npx tsx 05-sliding-window-head.ts` | Setup context and the latest blocker remain, but the middle drops out |
| [06-system-prompt-caching.ts](./examples/06-system-prompt-caching.ts) | `cd examples && npx tsx 06-system-prompt-caching.ts` | System instructions consolidate into a stable prefix |
| [07-model-backed-summarization.ts](./examples/07-model-backed-summarization.ts) | `cd examples && npx tsx 07-model-backed-summarization.ts` | A model-generated summary replaces older discussion |
| [08-scratchpad.ts](./examples/08-scratchpad.ts) | `cd examples && npx tsx 08-scratchpad.ts` | `scratchpad(...)` changes what the next turn sees |
| [09-pinned-messages.ts](./examples/09-pinned-messages.ts) | `cd examples && npx tsx 09-pinned-messages.ts` | One pinned tool result survives while other old ones decay |
| [10-compaction-tool.ts](./examples/10-compaction-tool.ts) | `cd examples && npx tsx 10-compaction-tool.ts` | `compact_context(...)` compacts now and reuses the stored summary later |
| [11-context-utilization-reminder.ts](./examples/11-context-utilization-reminder.ts) | `cd examples && npx tsx 11-context-utilization-reminder.ts` | The latest user message gains a warning before hard pruning starts |

See [`examples/README.md`](./examples/README.md) for the full example index.

## Runtime API

### `createContextManagementRuntime({ strategies, telemetry, estimator })`

Returns:

- `middleware`
- `optionalTools`

The runtime merges tools from all strategies and throws on tool-name collisions.

## Scratchpad API

`ScratchpadStrategy` exposes a `scratchpad(...)` tool for maintaining current working state across turns.

The tool supports:

- `description`: required one-line note describing what this scratchpad update is doing
- `setEntries`: merge key/value entries into the scratchpad
- `replaceEntries`: replace all key/value entries
- `removeEntryKeys`: delete specific entries by key
- `preserveTurns`: keep the first `N` and last `N` user/assistant turns from before this `scratchpad(...)` call, trimming only the middle and excluding tool use from the visible transcript
- `omitToolCallIds`: remove completed tool exchanges after the important parts have been captured

Entry names are intentionally unconstrained. Common choices are `objective`, `thesis`, `findings`, `notes`, `side-effects`, and `next-steps`, but the agent can use whatever keys match the task.

## Telemetry

The runtime can emit raw events for every request:

- `runtime-start`
- `strategy-complete`
- `tool-execute-start`
- `tool-execute-complete`
- `tool-execute-error`
- `runtime-complete`

These events include request context, before/after token estimates, removed-tool deltas, pinned-tool deltas, and the final provider-facing prompt snapshot after middleware runs. The `runtime-complete` event also includes the final `providerOptions` and `toolChoice`.

## Utilities

The package also exports:

- `createDefaultPromptTokenEstimator`
- `createLlmSummarizer`
- `buildSummaryTranscript`
- `buildDeterministicSummary`
- `CONTEXT_MANAGEMENT_KEY`

## Running Locally

```bash
bun test
bun run typecheck
bun run build
```
