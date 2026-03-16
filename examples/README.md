# Examples

Runnable examples for each strategy.

These examples are deterministic and do not require a live model backend. Each script uses a mock model, captures the transformed prompt, and prints the part that is worth inspecting.

Install the example dependencies first:

```bash
cd examples
npm install
```

Then run any example with:

```bash
npx tsx 01-sliding-window.ts
```

## Strategy Examples

### `01-sliding-window.ts`

- shows the recent-tail policy
- look for the oldest exchange disappearing from the prompt

### `02-tool-result-decay.ts`

- shows full, truncated, and placeholder zones for tool results
- look for old tool outputs becoming `[result omitted]`

### `03-summarization.ts`

- shows older turns collapsing into a tagged summary system message
- look for the recent tail staying raw

### `04-composed-strategies.ts`

- shows a graduated stack with telemetry
- look for multiple effects in one prompt: normalized system prefix, compressed tool results, summary, scratchpad reminder, and utilization warning

### `05-sliding-window-head.ts`

- shows setup context plus recent context staying in view
- look for the middle status updates disappearing

### `06-system-prompt-caching.ts`

- shows plain system prompts consolidating into one stable prefix
- look for non-system message order staying unchanged

### `07-llm-summarization.ts`

- shows model-backed summarization
- look for an LLM-generated summary message replacing older turns

### `08-scratchpad.ts`

- shows the `scratchpad(...)` tool affecting future turns
- look for omitted tool exchanges disappearing and structured scratchpad state being injected into the latest user message

### `09-pinned-messages.ts`

- shows `pin_tool_result(...)` protecting a specific tool result
- look for one old tool result surviving while others decay

### `10-compaction-tool.ts`

- shows `compact_context(...)` triggering compaction on the next call
- look for the stored summary being injected again on the following turn

### `11-context-utilization-reminder.ts`

- shows a warning block appearing before hard pruning starts
- look for the latest user message gaining a utilization reminder
