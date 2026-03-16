# SummarizationStrategy

When a conversation gets long, you usually have two bad options: keep paying to send old turns verbatim, or drop them and hope the model does not need them later.

`SummarizationStrategy` is the host-controlled middle ground. Once the prompt crosses a token budget, it replaces older turns with one tagged summary block and keeps the recent tail verbatim.

This is the right strategy when you want automatic compaction, but you want to decide exactly how summaries are generated.

## Why You'd Use It

- preserves older facts in compressed form instead of hard-dropping them
- gives you a fixed budget for how much raw recent context survives
- lets the host supply a domain-specific summarizer instead of relying on generic model behavior
- makes summarization policy explicit and testable

## What Changes In The Prompt

- older turns are summarized into a tagged system message
- the most recent tail remains verbatim
- repeated summarization can build on a previous summary block

## What It Actually Does

When the prompt exceeds `maxPromptTokens`, the strategy:

- keeps the newest `keepLastMessages` untouched
- selects the older summarizable region
- passes that region to your `summarize(messages)` function
- inserts the returned summary as a tagged system message

If a previous summary block already exists, it is included in the next summarization pass so summaries can accumulate rather than restart from scratch.

## Why It's Different From The Adjacent Strategies

- `SummarizationStrategy`: same prompt rewrite every time, but you bring the summarizer
- `LLMSummarizationStrategy`: same rewrite, but the library provides a model-backed summarizer for you
- `ScratchpadStrategy`: the model manages its own working state instead of the host compressing history for it

## When To Reach For It

Use it when:

- you want automatic history compaction
- you already have a custom summarizer function or want a deterministic reducer
- you need summary content to follow your own domain rules

Skip it when:

- the model should actively choose what to preserve
- you want the library to handle the summarizer call for you

## Runnable Example

- [`examples/03-summarization.ts`](../../../examples/03-summarization.ts)
