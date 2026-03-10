# Examples

Runnable examples for `ai-sdk-context-mgmt-middleware`.

## Setup

```bash
cd examples
npm install
```

You'll need API keys set as environment variables:

```bash
export OPENAI_API_KEY=sk-...       # For OpenAI examples
export OLLAMA_BASE_URL=http://localhost:11434  # For Ollama examples (default)
```

## Examples

### 01-basic-passthrough.ts
Demonstrates the middleware doing nothing when messages fit within context window. Proves zero interference when compression isn't needed.

### 02-tool-output-policies.ts
Shows per-tool output policies: keep, truncate, and remove. Includes the `onToolOutputTruncated` hook for external storage integration.

### 03-llm-compression.ts
Tier-2 LLM-assisted compression using gpt-4o-mini (or ollama). Demonstrates summarization of older conversation segments.

### 04-full-pipeline.ts
Complete pipeline with all features: tool policies, LLM compression, caching, debug output, and the truncation hook. A realistic production scenario.

## Running

```bash
# Run with tsx
npx tsx 01-basic-passthrough.ts
npx tsx 02-tool-output-policies.ts
npx tsx 03-llm-compression.ts
npx tsx 04-full-pipeline.ts
```
