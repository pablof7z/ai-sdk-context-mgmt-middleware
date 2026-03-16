# LLMSummarizationStrategy

`LLMSummarizationStrategy` is not a different pruning algorithm from `SummarizationStrategy`. It is the same summary-replacement behavior, but with the summarizer built in.

When the prompt gets too large, older turns are replaced by one summary block. The difference is that the library formats the old context, calls an AI SDK model to write the summary, and falls back to a deterministic summary if that model path fails.

Use this when you want the benefits of automatic summarization without wiring your own `summarize(...)` function.

## Why You'd Use It

- same automatic compaction behavior as `SummarizationStrategy`
- better summary quality than a naive string reducer in many cases
- less host code: give it a model instead of building your own summarizer wrapper
- safer operationally because it has a deterministic fallback path

## What Changes In The Prompt

- older turns are replaced by an LLM-produced summary
- the recent tail remains raw
- a deterministic fallback summary is used if the LLM path fails

## What It Actually Does

Internally it:

- formats the older context into a compact transcript
- calls a model with a summarization prompt
- uses the model's text as the summary block when available
- falls back to a deterministic summary if the model call fails or returns nothing
- delegates the actual prompt rewrite to `SummarizationStrategy`

## Quick Comparison

- choose `SummarizationStrategy` when you want to own the `summarize(messages)` implementation
- choose `LLMSummarizationStrategy` when you want the library to provide that implementation
- both strategies replace older turns with a tagged summary block and preserve the recent tail

## When To Reach For It

Use it when:

- you want summary quality from a model-backed summarizer
- you do not want to hand-roll transcript formatting and fallback logic
- you want a higher-level default for long conversations

Skip it when:

- you need a custom summarizer pipeline
- you want fully deterministic summary generation without any model call

## Runnable Example

- [`examples/07-llm-summarization.ts`](../../../examples/07-llm-summarization.ts)
