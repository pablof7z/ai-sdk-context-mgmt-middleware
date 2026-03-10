# Examples

Runnable examples for `ai-sdk-context-mgmt-middleware`.

## Setup

```bash
cd examples
npm install
```

The examples use mock segment generation by default, so they run without API keys.

## Examples

### 01-basic-passthrough.ts
Uses `createContextManagementMiddleware(...)` with a large token budget to show zero prompt changes when no context management work is needed.

### 02-tool-output-policies.ts
Shows that the new `toolPolicy(context)` function can look at both the tool call and the tool result, and that tool-call/result compression still runs below the segment-compression threshold.

### 03-persisted-segments.ts
Demonstrates `SegmentStore` + `resolveConversationKey(...)`. The first call generates a segment, and the second call reuses it from store-backed state.

### 04-full-pipeline.ts
Production-style adapter setup with:
- cache
- segment store
- explicit conversation key
- tool-content truncation hook
- `toolPolicy(context)`
- `createSegmentGenerator(...)`

### 05-manage-context.ts
Uses the pure `manageContext(...)` API directly, without the AI SDK adapter.

## Running

```bash
npx tsx 01-basic-passthrough.ts
npx tsx 02-tool-output-policies.ts
npx tsx 03-persisted-segments.ts
npx tsx 04-full-pipeline.ts
npx tsx 05-manage-context.ts
```
