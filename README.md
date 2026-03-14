# ai-sdk-context-management

Telemetry-aware middleware-driven context management for AI SDK language models.

This package provides a runtime that returns:

- AI SDK middleware for rewriting provider prompts before each model call
- optional SDK tools that agents can execute to manage their own future context
- structured runtime telemetry so hosts can understand exactly what happened

Typical graduated stacks combine:

- `SystemPromptCachingStrategy`
- `ToolResultDecayStrategy`
- `SummarizationStrategy`
- `ScratchpadStrategy`
- `ContextUtilizationReminderStrategy`

## Installation

```bash
npm install ai @ai-sdk/provider ai-sdk-context-management
```

## Request Context Contract

The middleware reads `providerOptions.contextManagement` and returned tools read `experimental_context.contextManagement`. Both must carry the same request-scoped identity:

```ts
{
  conversationId: string;
  agentId: string;
  agentLabel?: string;
}
```

## Quick Start

```ts
import { generateText, wrapLanguageModel } from "ai";
import {
  ContextUtilizationReminderStrategy,
  ScratchpadStrategy,
  SummarizationStrategy,
  SystemPromptCachingStrategy,
  ToolResultDecayStrategy,
  createContextManagementRuntime,
  createDefaultPromptTokenEstimator,
} from "ai-sdk-context-management";

const scratchpads = new Map<string, any>();
const estimator = createDefaultPromptTokenEstimator();

const runtime = createContextManagementRuntime({
  strategies: [
    new SystemPromptCachingStrategy(),
    new ToolResultDecayStrategy({
      maxPromptTokens: 24_000,
      estimator,
    }),
    new SummarizationStrategy({
      summarize: async (messages) => {
        return `Summary of ${messages.length} messages`;
      },
      maxPromptTokens: 36_000,
      estimator,
    }),
    new ScratchpadStrategy({
      scratchpadStore: {
        get: ({ conversationId, agentId }) => scratchpads.get(`${conversationId}:${agentId}`),
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

## API

### `createContextManagementRuntime({ strategies, telemetry, estimator })`

Returns:

- `middleware`
- `optionalTools`

Strategies run in order. The runtime merges optional tools across all strategies and throws on tool-name collisions.

### Telemetry

The runtime can emit raw decision events for every request:

- `runtime-start`
- `strategy-complete`
- `tool-execute-start`
- `tool-execute-complete`
- `tool-execute-error`
- `runtime-complete`

Strategy events include:

- token counts before/after
- outcome and reason
- removed/pinned deltas
- full `promptBefore` / `promptAfter`
- strategy-specific payload objects

Tool events include raw input/result/error payloads plus request context.

### `ToolResultDecayStrategy`

Options:

- `keepFullResultCount`
- `truncateWindowCount`
- `truncatedMaxTokens`
- `maxPromptTokens`
- `placeholder`
- `estimator`

Behavior:

- keeps recent tool results raw
- truncates medium-age tool outputs
- replaces older tool outputs with placeholders
- leaves the tool-call / reasoning chain intact

### `SummarizationStrategy`

Options:

- `summarize`
- `maxPromptTokens`
- `keepLastMessages`
- `estimator`

Behavior:

- keeps recent tail messages raw
- summarizes older messages only after the prompt crosses a configured threshold
- preserves tool-call/tool-result adjacency at the tail boundary

### `ScratchpadStrategy`

Options:

- `scratchpadStore`
- `reminderTone`
- `maxRemovedToolReminderItems`

Returns one tool: `scratchpad`

Tool input:

```ts
{
  notes?: string;
  keepLastMessages?: number | null;
  omitToolCallIds?: string[];
}
```

Behavior:

- loads the current agent scratchpad
- optionally omits older tool exchanges by `toolCallId`
- optionally shrinks the visible tail further
- injects a compact reminder into the latest user message with:
  - the current agent scratchpad
  - other agents' scratchpads with attribution
  - removed tool exchanges

### `ContextUtilizationReminderStrategy`

Options:

- `workingTokenBudget`
- `warningThresholdRatio`
- `mode`
- `estimator`

Behavior:

- warns once the current prompt crosses a percentage of the configured working budget
- uses scratchpad-specific guidance when `mode === "scratchpad"`
- appends the warning after other context-management rendering

## Running Locally

```bash
bun test
bun run typecheck
bun run build
```

## Examples

See [`examples/README.md`](./examples/README.md) for runnable examples.
