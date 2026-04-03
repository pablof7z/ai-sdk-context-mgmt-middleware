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

- shows pressure-aware full-vs-placeholder behavior for tool results
- look for older heavy results turning into re-read placeholders as tool-context pressure rises

### `03-summarization.ts`

- shows older turns collapsing into a tagged summary system message
- look for the recent tail staying raw

### `04-composed-strategies.ts`

- shows a graduated stack with telemetry
- look for multiple effects in one prompt: compressed tool results, summary, scratchpad reminder, and utilization warning

### `05-sliding-window-head.ts`

- shows setup context plus recent context staying in view
- look for the middle status updates disappearing

### `06-anthropic-prompt-caching.ts`

- shows provider-specific Anthropic cache hints landing on a naturally stable prompt prefix
- look for the unchanged leading history getting the breakpoint while the changing user turn stays outside it

### `07-model-backed-summarization.ts`

- shows model-backed summarization
- look for an LLM-generated summary message replacing older turns

### `08-scratchpad.ts`

- shows the `scratchpad(...)` tool affecting future turns
- look for structured scratchpad state being injected into the latest user message

### `09-pinned-messages.ts`

- shows `pin_tool_result(...)` protecting a specific tool result
- look for one old tool result surviving while others decay

### `10-compaction-tool.ts`

- shows `compact_context({ guidance?, from?, to? })` queuing an anchored host-driven compaction for the next call
- look for the stored compaction being re-applied again on the following turn

### `11-context-utilization-reminder.ts`

- shows `RemindersStrategy` emitting a warning block before hard pruning starts
- look for the latest user message gaining a utilization reminder
