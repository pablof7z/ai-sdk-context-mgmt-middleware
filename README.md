# ai-sdk-context-management

Context management for AI SDK agents: explicit prompt preparation, optional agent tools, and structured telemetry.

Every agent eventually runs into the same problem: the next model call cannot see everything. Context management is the policy that decides:

- what stays verbatim
- what gets compressed
- what can be dropped
- what should stay stable for prompt caching
- when the agent should manage its own future context

`ai-sdk-context-management` sits at the model boundary. It does not replace your thread store or orchestrator. It prepares the exact `messages` payload you send to AI SDK before each call and exposes optional tools that let the agent shape later turns.

## Installation

```bash
npm install ai @ai-sdk/provider ai-sdk-context-management
```

## Quick Start

The minimum integration is small:

```ts
import { generateText } from "ai";
import {
  ToolResultDecayStrategy,
  createContextManagementRuntime,
} from "ai-sdk-context-management";

const requestContext = {
  conversationId: "conv-123",
  agentId: "agent-456",
};

const runtime = createContextManagementRuntime({
  strategies: [new ToolResultDecayStrategy()],
});

const prepared = await runtime.prepareRequest({
  requestContext,
  messages,
  tools: {
    ...agentTools,
    ...runtime.optionalTools,
  },
  model: {
    provider: "openrouter",
    modelId: "anthropic/claude-4",
  },
});

const result = await generateText({
  model: baseModel,
  messages: prepared.messages,
  tools: {
    ...agentTools,
    ...runtime.optionalTools,
  },
  toolChoice: prepared.toolChoice,
  providerOptions: prepared.providerOptions,
  experimental_context: { contextManagement: requestContext },
});

await prepared.reportActualUsage(result.usage.inputTokens);
```

That is the core contract:

- call `runtime.prepareRequest(...)` immediately before the model call
- merge in `runtime.optionalTools` if you use tool-emitting strategies
- pass the same request context to `experimental_context` for optional tool execution
- call `reportActualUsage(...)` with the provider-reported input-token count after the model step completes

`RemindersStrategy({ contextWindowStatus })` uses that reported input-token count on later turns, together with `getContextWindow(...)`, to emit raw model-window status reminders without estimator-based working-budget math.

If you want the full stack version with telemetry, summarization, scratchpad, and reminders, run [`examples/04-composed-strategies.ts`](./examples/04-composed-strategies.ts).

## Request Context Contract

`prepareRequest(...)` requires `requestContext`.

Optional tools read `experimental_context.contextManagement`.

Both must contain the same request-scoped identity:

```ts
{
  conversationId: string;
  agentId: string;
  agentLabel?: string;
}
```

If that context is missing, `prepareRequest(...)` cannot run and context-management tools will reject execution.

## Strategy Index

Per-strategy docs live in [`src/strategies/`](./src/strategies/README.md).

| Strategy | What changes in the prompt | What the agent gets | Docs | Runnable example |
| --- | --- | --- | --- | --- |
| `RemindersStrategy` | Owns reminder production, delta tracking, and placement into overlay messages, fallback system blocks, or latest-user appends | One reminder pipeline for host facts, built-in warnings, and provider-aware delivery, including raw context-window status from provider-reported usage | [docs](./src/strategies/reminders/README.md) | [11-context-utilization-reminder.ts](./examples/11-context-utilization-reminder.ts) |
| `AnthropicPromptCachingStrategy` | Adds Anthropic cache hints after final prompt assembly | Provider-specific cache breakpointing for naturally stable prompt prefixes | [docs](./src/strategies/anthropic-prompt-caching/README.md) | [06-anthropic-prompt-caching.ts](./examples/06-anthropic-prompt-caching.ts) |
| `SlidingWindowStrategy` | Keeps the recent tail, can optionally preserve a head, and drops older non-system turns | Bounded context with simple recency bias or setup preservation | [docs](./src/strategies/sliding-window/README.md) | [01-sliding-window.ts](./examples/01-sliding-window.ts) |
| `ToolResultDecayStrategy` | Leaves recent tool results raw, then replaces older oversized results with placeholders based on depth and total tool-context pressure | Keeps the reasoning chain while continuously hiding stale heavy payloads without waiting for a prompt-budget cliff | [docs](./src/strategies/tool-result-decay/README.md) | [02-tool-result-decay.ts](./examples/02-tool-result-decay.ts) |
| `SummarizationStrategy` | Replaces older turns with a tagged summary block using either `summarize(...)` or `model` | Older facts survive in compressed form without replaying the whole middle | [docs](./src/strategies/summarization/README.md) | [03-summarization.ts](./examples/03-summarization.ts), [07-model-backed-summarization.ts](./examples/07-model-backed-summarization.ts) |
| `ScratchpadStrategy` | Injects persisted scratchpad state and can compact older transcript around scratchpad checkpoints | Structured working state, note edits, and agent-driven transcript compaction | [docs](./src/strategies/scratchpad/README.md) | [08-scratchpad.ts](./examples/08-scratchpad.ts) |
| `PinnedMessagesStrategy` | Marks specific tool call IDs as protected before pruning | Lets the agent keep the evidence it considers critical | [docs](./src/strategies/pinned-messages/README.md) | [09-pinned-messages.ts](./examples/09-pinned-messages.ts) |
| `CompactionToolStrategy` | Replaces selected stale `user`/`assistant` history with anchored continuation summaries, either when the agent calls `compact_context(...)` or when the host auto-compacts | Agent-controlled and host-controlled semantic compaction with persistent overlays | [docs](./src/strategies/compaction-tool/README.md) | [10-compaction-tool.ts](./examples/10-compaction-tool.ts) |

## Provider Caching Split

`RemindersStrategy` decides reminder content and placement. `AnthropicPromptCachingStrategy` runs after that final prompt assembly and only adds provider-specific cache metadata.

This split matters for Anthropic prompt caching: cache breakpoints should follow naturally stable leading prompt content. If the system prompt or earlier conversation history changes, the shared-prefix cache is invalidated.

## Strategy Ordering

Strategies run in array order. A good default is:

1. `PinnedMessagesStrategy`
2. pruning and compression strategies
3. agent-directed context tools
4. `RemindersStrategy`
5. `AnthropicPromptCachingStrategy` when the provider is Anthropic

In practice that usually means:

1. `PinnedMessagesStrategy`
2. `SlidingWindowStrategy` (optionally with `headCount`), `ToolResultDecayStrategy`, or `SummarizationStrategy`
3. `ScratchpadStrategy` or `CompactionToolStrategy`
4. `RemindersStrategy`
5. `AnthropicPromptCachingStrategy`

## Choosing A Stack

- Short, bounded conversations: `SlidingWindowStrategy`
- Preserve setup plus the latest turns: `SlidingWindowStrategy({ headCount, keepLastMessages })`
- Tool-heavy agents: `ToolResultDecayStrategy` + `RemindersStrategy`
- Long-running agents: `PinnedMessagesStrategy` + `ToolResultDecayStrategy` + `SummarizationStrategy({ model })` + `RemindersStrategy`
- Anthropic-heavy agents with naturally stable leading context: `AnthropicPromptCachingStrategy` after your normal prompt-shaping strategies
- Agents that self-manage context: `PinnedMessagesStrategy` + `ScratchpadStrategy` + `CompactionToolStrategy` + `RemindersStrategy`
- Full graduated stack: run [`examples/04-composed-strategies.ts`](./examples/04-composed-strategies.ts)

## Tool Result Decay

`ToolResultDecayStrategy` now decays tool context using:

- `effectiveDepth = depth * pressureFactor(toolContextTokens)`
- default pressure anchors:
  - `100 -> 0.05`
  - `5_000 -> 1`
  - `50_000 -> 5`

That means low-token tool usage can remain intact for many turns, while heavy tool sessions decay aggressively much earlier.

There is no total-prompt activation threshold. Tool-result decay runs on every prompt so large stale tool payloads do not linger just because the overall request is still under budget.

You can tune the curve with `pressureAnchors` and the warning forecast with `warningForecastExtraTokens`:

```ts
new ToolResultDecayStrategy({
  pressureAnchors: [
    { toolTokens: 100, depthFactor: 0.05 },
    { toolTokens: 5_000, depthFactor: 1 },
    { toolTokens: 50_000, depthFactor: 5 },
  ],
  placeholderMinSourceTokens: 800,
  warningForecastExtraTokens: 10_000,
});
```

Warnings are emitted through `RemindersStrategy`, which can place them into overlay messages, fallback system blocks, or latest-user appends depending on policy:

- `tool_call_ids`
- `placeholder_ids`
- `forecast_extra_tool_tokens`
- `forecast_tool_context_tokens`

## Runnable Examples

All examples are local and deterministic. They use mock models, print the transformed prompt, and show exactly what is interesting about the output.

| Example | Run | What to look for |
| --- | --- | --- |
| [01-sliding-window.ts](./examples/01-sliding-window.ts) | `cd examples && npx tsx 01-sliding-window.ts` | The oldest exchange disappears, so the model only sees the recent tail |
| [02-tool-result-decay.ts](./examples/02-tool-result-decay.ts) | `cd examples && npx tsx 02-tool-result-decay.ts` | Pressure-aware decay keeps light tool history longer, then replaces older heavy results with placeholders |
| [03-summarization.ts](./examples/03-summarization.ts) | `cd examples && npx tsx 03-summarization.ts` | A tagged summary system message replaces older turns |
| [04-composed-strategies.ts](./examples/04-composed-strategies.ts) | `cd examples && npx tsx 04-composed-strategies.ts` | Multiple strategies stack cleanly and telemetry shows what ran |
| [05-sliding-window-head.ts](./examples/05-sliding-window-head.ts) | `cd examples && npx tsx 05-sliding-window-head.ts` | Setup context and the latest blocker remain, but the middle drops out |
| [06-anthropic-prompt-caching.ts](./examples/06-anthropic-prompt-caching.ts) | `cd examples && npx tsx 06-anthropic-prompt-caching.ts` | Naturally stable leading prompt history gets the Anthropic cache breakpoint |
| [07-model-backed-summarization.ts](./examples/07-model-backed-summarization.ts) | `cd examples && npx tsx 07-model-backed-summarization.ts` | A model-generated summary replaces older discussion |
| [08-scratchpad.ts](./examples/08-scratchpad.ts) | `cd examples && npx tsx 08-scratchpad.ts` | `scratchpad(...)` changes what the next turn sees |
| [09-pinned-messages.ts](./examples/09-pinned-messages.ts) | `cd examples && npx tsx 09-pinned-messages.ts` | One pinned tool result survives while other old ones decay |
| [10-compaction-tool.ts](./examples/10-compaction-tool.ts) | `cd examples && npx tsx 10-compaction-tool.ts` | `compact_context({ guidance?, from?, to? })` asks the host to compact now and reapplies the stored compaction later |
| [11-context-utilization-reminder.ts](./examples/11-context-utilization-reminder.ts) | `cd examples && npx tsx 11-context-utilization-reminder.ts` | `RemindersStrategy` adds a warning before hard pruning starts |

See [`examples/README.md`](./examples/README.md) for the full example index.

## Runtime API

### `createContextManagementRuntime({ strategies, telemetry, estimator })`

Returns:

- `prepareRequest`
- `optionalTools`

`prepareRequest(...)` returns:

- `messages`
- `providerOptions`
- `toolChoice`
- `runtimeOverlays`
- `reportActualUsage(actualInputTokens)`

The runtime merges tools from all strategies and throws on tool-name collisions.

## Scratchpad API

`ScratchpadStrategy` exposes a `scratchpad(...)` tool for maintaining current working state across turns.

The tool supports:

- `description`: required one-line note describing what this scratchpad update is doing
- `setEntries`: merge key/value entries into the scratchpad
- `replaceEntries`: replace all key/value entries
- `removeEntryKeys`: delete specific entries by key
- `preserveTurns`: keep the first `N` and last `N` user/assistant turns from before this `scratchpad(...)` call, trimming only the middle while preserving the raw messages inside those kept turns

Entry names are intentionally unconstrained.

Hosts can pass `emptyStateGuidance` to `ScratchpadStrategy` if they want to inject host-specific empty-scratchpad hints or behavioral guidance. The library does not add those hints by default.

## Telemetry

The runtime can emit raw events for every request:

- `runtime-start`
- `strategy-complete`
- `tool-execute-start`
- `tool-execute-complete`
- `tool-execute-error`
- `runtime-complete`

These events include request context, before/after token estimates, removed-tool deltas, pinned-tool deltas, and the final provider-facing prompt snapshot after `prepareRequest(...)` runs. The `runtime-complete` event also includes the final `providerOptions` and `toolChoice`.

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
