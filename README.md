# ai-sdk-context-mgmt-middleware

AI SDK v6 middleware for intelligent context window management. Automatically compresses conversation history to fit within token limits using a two-tier pipeline.

## How It Works

When conversation history approaches the context window limit, the middleware intercepts `transformParams` and applies compression in two tiers:

1. **Rule-based compression** (fast, no LLM calls): Truncates/removes tool outputs based on policies, applies age-based decay
2. **LLM-assisted compression** (when rule-based isn't enough): Uses a separate LLM to summarize conversation segments

The middleware tracks token usage and only activates when the estimated token count exceeds the configured threshold.

## Installation

```bash
npm install ai-sdk-context-mgmt-middleware
```

## Quick Start

```typescript
import { contextManagement } from "ai-sdk-context-mgmt-middleware";
import { wrapLanguageModel } from "ai";
import { generateText, streamText } from "ai";
import { openai } from "@ai-sdk/openai";

// Create the middleware
const middleware = contextManagement({
  maxTokens: 128_000,
  compressionThreshold: 0.8, // Compress when 80% full
});

// Wrap your model with the middleware
const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware,
});

// Use with generateText
const result = await generateText({
  model,
  messages: conversationHistory, // Can be arbitrarily long
});

// Or with streamText
const stream = streamText({
  model,
  messages: conversationHistory,
});
```

The middleware transparently compresses the messages array before it reaches the model. Your application code doesn't need to change.

## Configuration

```typescript
const middleware = contextManagement({
  // Required: maximum context window size
  maxTokens: 128_000,

  // When to start compressing (0-1, default 0.8)
  compressionThreshold: 0.8,

  // How many recent messages to never compress (default 4)
  protectedMessageCount: 4,

  // Tool output handling (see below)
  toolOutputPolicy: { /* ... */ },

  // LLM compressor for tier-2 (optional)
  llmCompressor: createLLMCompressor({ /* ... */ }),

  // Cache for compression results (optional)
  cache: createCompressionCache({ maxEntries: 100 }),

  // Hook: called when tool outputs are truncated/removed
  onToolOutputTruncated: async (event) => { /* ... */ },

  // Debug callback
  onDebug: (info) => console.log(info),
});
```

### Tool Output Policies

Control how tool call results are handled during compression. Policies are: `"keep"`, `"truncate"`, or `"remove"`.

```typescript
const middleware = contextManagement({
  maxTokens: 128_000,
  toolOutputPolicy: {
    defaultPolicy: "truncate",
    maxOutputTokens: 500,
    perTool: {
      search_results: { policy: "truncate", maxTokens: 200 },
      get_file: { policy: "truncate", maxTokens: 1000 },
      debug_logs: { policy: "remove" },
      important_data: { policy: "keep" },
    },
  },
});
```

### Tool Output Truncation Hook

Get notified when tool outputs are compressed, and optionally provide replacement text (e.g., with retrieval instructions pointing to a RAG store):

```typescript
const middleware = contextManagement({
  maxTokens: 128_000,
  onToolOutputTruncated: async (event) => {
    // event.toolName - which tool's output was truncated
    // event.toolCallId - the tool call ID
    // event.originalOutput - the full original output text
    // event.originalTokens - token estimate of original
    // event.removed - true if completely removed, false if truncated

    // Store original output externally
    const storageId = await ragStore.save(event.originalOutput);

    // Return replacement text (optional - default truncation text used if undefined)
    return `[Output stored. Retrieve with: rag_get("${storageId}")]`;
  },
});
```

### LLM-Assisted Compression

For deeper compression when rule-based isn't enough, provide an LLM compressor:

```typescript
import { createLLMCompressor } from "ai-sdk-context-mgmt-middleware";
import { openai } from "@ai-sdk/openai";

const middleware = contextManagement({
  maxTokens: 128_000,
  llmCompressor: createLLMCompressor({
    model: openai("gpt-4o-mini"), // Cheap model for summarization
    maxSummaryTokens: 500,
  }),
});
```

### Caching

Avoid re-compressing the same messages:

```typescript
import { createCompressionCache } from "ai-sdk-context-mgmt-middleware";

const middleware = contextManagement({
  maxTokens: 128_000,
  cache: createCompressionCache({ maxEntries: 100 }),
});
```

## Architecture

```
transformParams interceptor
  ├─ Estimate token count
  ├─ Below threshold? → pass through unchanged
  └─ Above threshold?
      ├─ Check cache → hit? return cached
      ├─ Tier 1: Rule-based compression
      │   ├─ Apply tool output policies (keep/truncate/remove)
      │   ├─ Fire onToolOutputTruncated hooks
      │   └─ Age-based decay (older messages treated more aggressively)
      ├─ Still over limit?
      │   └─ Tier 2: LLM-assisted compression
      │       └─ Summarize oldest message segments
      ├─ Cache result
      └─ Return compressed messages
```

## API

### `contextManagement(config)`

Creates middleware compatible with AI SDK v6's `wrapLanguageModel`. Returns a `LanguageModelMiddleware` object.

### `createDefaultEstimator(charsPerToken?: number)`

Creates a token estimator using character-ratio heuristic. Default ratio is 4 chars/token.

### `createLLMCompressor(options)`

Creates an LLM-based compressor for tier-2 compression.

- `options.model` — AI SDK language model instance for summarization
- `options.maxSummaryTokens` — Max tokens for the summary output (default 500)

### `createCompressionCache(options?)`

Creates an in-memory LRU cache for compression results.

- `options.maxEntries` — Maximum cache entries (default 50)

### `hashMessages(messages)`

Generates a content hash for a message array (useful for custom caching).

## License

MIT
