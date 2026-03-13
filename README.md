# ai-sdk-context-management

Middleware-driven context management for AI SDK language models.

This package provides a small runtime that returns:

- AI SDK middleware for rewriting provider prompts before each model call
- optional SDK tools that agents can execute to manage their own future context

V1 ships two independent strategies:

- `SlidingWindowStrategy`: aggressively keeps a focused recent window
- `ScratchpadStrategy`: lets agents update scratchpad notes and proactively omit older tool exchanges

## Installation

```bash
npm install ai @ai-sdk/provider ai-sdk-context-management
```

## Request Context Contract

The host must pass the same request-scoped identity in both:

- `providerOptions.contextManagement`
- `experimental_context.contextManagement`

```ts
{
  conversationId: string;
  agentId: string;
  agentLabel?: string;
}
```

The middleware reads `providerOptions.contextManagement`.  
Returned tools read `experimental_context.contextManagement`.

## Quick Start

```ts
import { generateText, wrapLanguageModel } from "ai";
import {
  createContextManagementRuntime,
  ScratchpadStrategy,
  SlidingWindowStrategy,
} from "ai-sdk-context-management";

const scratchpads = new Map<string, any>();

const runtime = createContextManagementRuntime({
  strategies: [
    new SlidingWindowStrategy({ keepLastMessages: 6 }),
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
    }),
  ],
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
  providerOptions: {
    contextManagement: {
      conversationId: "conv-123",
      agentId: "agent-456",
      agentLabel: "Researcher",
    },
  },
  experimental_context: {
    contextManagement: {
      conversationId: "conv-123",
      agentId: "agent-456",
      agentLabel: "Researcher",
    },
  },
});
```

## API

### `createContextManagementRuntime({ strategies })`

Returns:

- `middleware`
- `optionalTools`

Strategies run in order. The runtime merges optional tools across all strategies and throws on tool-name collisions.

### `SlidingWindowStrategy`

Options:

- `keepLastMessages`
- `maxPromptTokens`
- `estimator`

Behavior:

- keeps all system messages
- keeps the newest non-system messages
- preserves tool-call/tool-result adjacency at the trim boundary
- records removed tool exchanges for later reminder rendering

### `ScratchpadStrategy`

Options:

- `scratchpadStore`
- `maxScratchpadChars`
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

## Running Locally

```bash
bun test
bun run typecheck
bun run build
```

## Examples

See [`examples/README.md`](./examples/README.md) for runnable examples.
