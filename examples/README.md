# Examples

Runnable examples for the middleware-based runtime API.

Install the example dependencies first:

```bash
cd examples
npm install
```

Then run:

```bash
npx tsx 01-sliding-window.ts
npx tsx 02-tool-result-decay.ts
npx tsx 03-summarization.ts
npx tsx 04-composed-strategies.ts
```

## Examples

### `01-sliding-window.ts`

- shows the legacy sliding-window strategy in isolation

### `02-tool-result-decay.ts`

- shows progressive compression of older tool outputs
- keeps the reasoning/tool-call chain intact while shrinking result payloads

### `03-summarization.ts`

- shows fallback summarization once a prompt exceeds a configured token budget
- keeps the recent tail raw and compresses only older history

### `04-composed-strategies.ts`

- composes caching, decay, summarization, and reminders into one pipeline
- demonstrates the telemetry callback so hosts can inspect runtime decisions
