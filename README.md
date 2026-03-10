# @tenex/context-mgmt

AI SDK v6 middleware for intelligent context window management. Automatically compresses conversation history to fit within token limits using a two-tier pipeline.

## How It Works

When conversation history approaches the context window limit, the middleware intercepts `transformParams` and applies compression in two tiers:

1. **Rule-based compression** (fast, no LLM calls): Truncates tool outputs, collapses older messages, applies decay based on message age
2. **LLM-assisted compression** (when rule-based isn't enough): Uses a separate LLM to summarize conversation segments

The middleware tracks token usage and only activates when the estimated token count exceeds the configured threshold.

## Installation

```bash
npm install @tenex/context-mgmt
```

## Quick Start

```typescript
import { contextManagement } from "@tenex/context-mgmt";
import { wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";

const middleware = contextManagement({
  maxTokens: 128_000,
  compressionThreshold: 0.8, // Compress when 80% full
});

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware,
});
```

## Configuration

```typescript
interface ContextManagementConfig {
  // Token limits
  maxTokens: number;
  compressionThreshold?: number; // 0-1, default 0.8

  // Tool output handling
  toolOutputPolicy?: ToolOutputPolicy;

  // Custom token estimator (default uses char-ratio heuristic)
  estimateTokens?: TokenEstimator;

  // LLM compressor for tier-2 compression
  llmCompressor?: LLMCompressor;

  // Cache for compression results
  cache?: CompressionCache;

  // Enable debug output
  debug?: boolean;
}
```

### Tool Output Policies

Control how tool call results are handled during compression:

```typescript
const middleware = contextManagement({
  maxTokens: 128_000,
  toolOutputPolicy: {
    defaultPolicy: "truncate",
    maxOutputTokens: 500,
    perTool: {
      search_results: { policy: "summarize", maxTokens: 200 },
      get_file: { policy: "truncate", maxTokens: 1000 },
      debug_logs: { policy: "remove" },
    },
  },
});
```

### LLM-Assisted Compression

For deeper compression, provide an LLM compressor:

```typescript
import { createLLMCompressor } from "@tenex/context-mgmt";
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
import { createCompressionCache } from "@tenex/context-mgmt";

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
      │   ├─ Apply tool output policies
      │   ├─ Age-based decay (older messages get more aggressive treatment)
      │   └─ Collapse sequential same-role messages
      ├─ Still over limit?
      │   └─ Tier 2: LLM-assisted compression
      │       └─ Summarize oldest message segments
      ├─ Cache result
      └─ Return compressed prompt
```

## API

### `contextManagement(config)`

Creates middleware compatible with AI SDK v6's `wrapLanguageModel`.

### `createDefaultEstimator(charsPerToken?: number)`

Creates a token estimator using character-ratio heuristic. Default ratio is 4 chars/token.

### `createLLMCompressor(options)`

Creates an LLM-based compressor for tier-2 compression.

### `createCompressionCache(options?)`

Creates an in-memory cache for compression results.

### `hashMessages(messages)`

Generates a content hash for a message array (useful for custom caching).

## License

MIT
