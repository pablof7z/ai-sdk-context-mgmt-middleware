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
npx tsx 02-scratchpad.ts
```

## Examples

### `01-sliding-window.ts`

- wraps a mock model with `SlidingWindowStrategy`
- shows the prompt that reaches the provider after trimming

### `02-scratchpad.ts`

- wraps a mock model with both strategies
- lets the model call the returned `scratchpad` tool
- shows the updated scratchpad state and the next-step prompt
