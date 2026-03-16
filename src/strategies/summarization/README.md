# SummarizationStrategy

When a conversation gets long, you usually have two bad options: keep paying to send old turns verbatim, or drop them and hope the model does not need them later.

`SummarizationStrategy` is the middle ground. Once the prompt crosses a token budget, it summarizes the older middle of the conversation into one tagged system message and keeps the recent tail raw.

Use it when you want automatic compaction and either:

- a custom `summarize(messages)` implementation
- a built-in model-backed summarizer by passing `model`

## Why You'd Use It

- preserves older facts in compressed form instead of hard-dropping them
- gives you a fixed budget for how much recent raw context survives
- lets you choose between a custom summarizer and the built-in model path
- keeps summarization policy explicit and testable

## What Changes In The Prompt

- older turns are replaced by a tagged summary system message
- the recent tail remains verbatim
- repeated summarization can build on a previous summary block

## What It Actually Does

When the prompt exceeds `maxPromptTokens`, the strategy:

- keeps the newest `preserveRecentMessages` untouched
- selects the older summarizable region
- generates a summary with either `summarize(messages)` or the built-in model path
- inserts the returned summary as a tagged system message

If a previous summary block already exists, it is included in the next summarization pass so summaries can accumulate rather than restart from scratch.

If you pass `model`, the built-in summarizer:

- formats the older context into a compact transcript
- calls the model with a fixed summarization prompt
- falls back to a deterministic summary if the model call fails or returns nothing

## Why It's Different From The Adjacent Strategies

- `SummarizationStrategy`: host-controlled history compression with either a custom or built-in summarizer
- `ScratchpadStrategy`: the model manages its own working state instead of the host compressing history for it

## When To Reach For It

Use it when:

- you want automatic history compaction
- you want better summaries without wiring your own summarizer function
- you need a custom summarizer pipeline for domain-specific rules

Skip it when:

- the model should actively choose what to preserve
- you want fully raw recency-based dropping with no summary block

## Runnable Examples

- [`examples/03-summarization.ts`](../../../examples/03-summarization.ts)
- [`examples/07-model-backed-summarization.ts`](../../../examples/07-model-backed-summarization.ts)
