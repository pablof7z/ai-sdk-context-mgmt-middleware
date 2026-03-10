# ai-sdk-context-mgmt-middleware

Reusable context management for AI SDK apps and Tenex-class systems.

The package has two layers:
- a pure context engine that works on normalized transcript entries
- a thin AI SDK middleware adapter that rewrites the outgoing prompt and persists summary segments through a host-owned store

## What It Does

On each turn the engine:
1. normalizes the full `messages[]` array into addressable entries
2. always applies tool output truncation/removal rules
3. reapplies any previously persisted summary segments
4. checks the token budget after those transforms
5. if still above the compression threshold, renders the newest unsummarized block before the protected tail into a transcript and asks an LLM for 1 or more replacement segments
6. applies those segments and returns the rewritten messages
7. enforces a final hard token budget fallback if the prompt is still too large

This keeps segment state outside the middleware. Hosts own persistence.

## Installation

```bash
npm install ai-sdk-context-mgmt-middleware
```

## Pure Engine

```ts
import { manageContext, createSegmentGenerator } from "ai-sdk-context-mgmt-middleware";

const segmentGenerator = createSegmentGenerator({
  async generate(prompt) {
    return await cheapModel(prompt);
  },
});

const result = await manageContext({
  messages: conversationEntries,
  maxTokens: 128_000,
  compressionThreshold: 0.8,
  protectedTailCount: 4,
  existingSegments: persistedSegments,
  segmentGenerator,
  toolOutput: {
    defaultPolicy: "truncate",
    maxTokens: 300,
    recentFullCount: 2,
    toolOverrides: {
      fs_read: "truncate",
      debug_logs: "remove",
      final_report: "keep",
    },
  },
});

// result.messages: rewritten transcript entries
// result.appliedSegments: canonical segment set for persistence
// result.newSegments: only the segments created on this turn
```

## AI SDK Middleware

```ts
import { wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  createCompressionCache,
  createContextManagementMiddleware,
  createSegmentGenerator,
} from "ai-sdk-context-mgmt-middleware";

const segmentStore = new Map<string, any[]>();

const middleware = createContextManagementMiddleware({
  maxTokens: 128_000,
  compressionThreshold: 0.8,
  protectedTailCount: 4,
  cache: createCompressionCache({ maxEntries: 100 }),
  segmentStore: {
    load: (conversationKey) => segmentStore.get(conversationKey) ?? [],
    save: (conversationKey, segments) => {
      segmentStore.set(conversationKey, segments);
    },
  },
  resolveConversationKey({ params }) {
    return (params.providerOptions as any).contextManagement.conversationId;
  },
  segmentGenerator: createSegmentGenerator({
    async generate(prompt) {
      return await cheapModel(prompt);
    },
  }),
  toolOutput: {
    defaultPolicy: "truncate",
    maxTokens: 300,
    recentFullCount: 2,
  },
});

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware,
});
```

`createContextManagementMiddleware` is also exported as `contextManagement`.

## Transcript Rendering

`createTranscript(entries, options?)` renders normalized entries into a transcript string and returns:
- `text`
- `shortIdMap`
- `firstId`
- `lastId`

The built-in renderer emits an XML-like transcript because it works well for structured LLM compression, but the API is generic and accepts a custom `TranscriptRenderer`.

## Segment Generation

`SegmentGenerator` implementations receive:
- `transcript`
- `targetTokens`
- `messages`
- `previousSegments`

They return structured segments:

```ts
[{ fromId, toId, compressed }]
```

Use `createSegmentGenerator(...)` for a default JSON-based helper, or provide your own implementation.

## Segment Persistence

The middleware does not keep hidden conversation state.

If you want summary chunks to be reused on the next turn, provide a `SegmentStore` and a `resolveConversationKey(...)` function. The middleware will:
- `load(conversationKey)` before compression
- `save(conversationKey, appliedSegments)` or `append(conversationKey, newSegments)` after compression

Append-only stores are supported because the engine only creates new segments for the newest unsummarized block before the protected tail.

## Tool Output Policy

Tool output policy is always applied, even when the conversation is still below the LLM compression threshold.

Policies:
- `keep`
- `truncate`
- `remove`

Optional hook:

```ts
onToolOutputTruncated: async (event) => {
  const storageId = await ragStore.save(event.originalOutput);
  return `[Tool output stored externally. Retrieve with rag_get("${storageId}")]`;
}
```

## Hard Budget Fallback

If tool policy plus segment compression still do not fit `maxTokens`, the engine drops older history until the prompt fits and inserts:

```txt
[Earlier conversation truncated to fit token budget]
```

This is a last-resort safety brake for provider calls.

## API

Primary exports:
- `manageContext(config)`
- `createContextManagementMiddleware(config)`
- `createTranscript(messages, options?)`
- `applySegments(messages, segments)`
- `validateSegments(messages, segments, options?)`
- `createSegmentGenerator(config)`
- `createCompressionCache(options?)`
- `createDefaultEstimator()`

Adapter helpers:
- `normalizeMessages(messages)`
- `promptToContextMessages(prompt)`
- `contextMessagesToPrompt(messages)`

## Notes

- Plain text entries get deterministic short IDs from `role + content`; duplicates are suffixed with `-2`, `-3`, etc.
- Tool-call and tool-result entries derive stable IDs from the AI SDK tool call ID.
- The package is text-first. Hosts should normalize multimodal content before compression if they need more control.

## License

MIT
