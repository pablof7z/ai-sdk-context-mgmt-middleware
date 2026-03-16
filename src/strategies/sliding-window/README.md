# SlidingWindowStrategy

Keeps the most recent non-system messages and can optionally preserve a head segment before dropping the middle.

## What Changes In The Prompt

- older non-system messages are removed
- an optional opening head can stay verbatim
- system messages stay
- tool call and tool result pairs are preserved at the trim boundary

## What The Agent Gets

- predictable bounded context
- lower latency and cost
- a bias toward the most recent conversation state
- optional preservation of initial task framing via `headCount`

## Runnable Example

- [`examples/01-sliding-window.ts`](../../../examples/01-sliding-window.ts)
