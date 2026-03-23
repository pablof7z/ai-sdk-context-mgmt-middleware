# ScratchpadStrategy

If an agent works across many turns, the raw transcript quickly becomes a bad working-memory layer. Important decisions get buried under old tool output, side effects are easy to forget, and the model starts paying for context it no longer needs.

`ScratchpadStrategy` gives the agent an explicit place to keep its current state. The model can rewrite what matters into a compact set of entries, drop stale tool exchanges after capturing the important bits, and see that distilled state injected back into the next turn.

This is the strategy to use when you want the agent to actively manage its own context instead of waiting for the host to summarize or prune it.

## Why You'd Use It

- keeps long-running coding or research agents from re-reading dead context
- gives the model a stable place to track decisions, findings, side effects, and next steps
- makes it safer to remove old tool output once the useful facts have been captured
- lets multiple agents in the same conversation share a lightweight working-state view

## What Changes In The Prompt

- tool exchanges listed in `omitToolCallIds` are removed
- older transcript context can be compacted with `preserveTurns`, keeping only head/tail user-assistant turns from before the latest scratchpad use
- a visible assistant notice records the latest scratchpad use in chronological order
- a reminder block is appended to the latest user message
- that reminder can include this agent's scratchpad entries and other agents' scratchpads

## What It Actually Does

On each turn, the strategy reads the persisted scratchpad state for the current agent and conversation. It can then:

- hide old tool exchanges the agent previously marked as safe to omit
- re-project the visible transcript as user turns plus assistant text replies, excluding tool use
- compact the pre-scratchpad history by keeping only the first and last preserved turns
- inject the agent's current working state back into the prompt as a reminder block

The key idea is that the scratchpad is not a chronological log. It is a living state snapshot that the model keeps rewriting as the task evolves.

## Mental Model

Think of the scratchpad as the agent's whiteboard:

- raw transcript: everything that happened
- scratchpad: what still matters

The transcript is noisy but complete. The scratchpad is compact but curated. The agent should copy durable facts into the scratchpad, then aggressively stop carrying raw context that no longer earns its cost.

## Scratchpad Tool Surface

The optional `scratchpad(...)` tool accepts:

- `description`: required one-line explanation of what this scratchpad update is doing
- `setEntries`: merge key/value entries into the scratchpad
- `replaceEntries`: replace the entire key/value map
- `removeEntryKeys`: delete specific keys
- `preserveTurns`: keep the first `N` and last `N` semantic turns from before this `scratchpad(...)` call while trimming only the middle
- `omitToolCallIds`: remove completed tool exchanges after their important parts are captured

Entry names are intentionally open-ended. Agents can use any keys that fit the task, instead of being forced into a fixed schema.

## Good Entry Shapes

- `objective`: what the agent is trying to accomplish right now
- `findings`: durable facts learned from tools or inspection
- `notes`: multiline freeform context when a single sentence is not enough
- `side-effects`: actions already taken that should not be repeated
- `next-steps`: what to do next without re-deriving the plan

## Recommended Usage Pattern

- treat the scratchpad as current state, not a log of every action
- rewrite stale entries instead of appending forever
- move important facts out of raw tool output and into entries
- once an insight is captured, omit the stale tool exchange from active context
- use `preserveTurns` when the scratchpad is good enough that the model only needs the head and tail turns around the current pruning point

## When To Reach For It

Use `ScratchpadStrategy` when:

- the agent performs multi-step work across many turns
- tool results are verbose, but only a few facts remain relevant
- you want the model itself to decide what state should persist
- you want some cross-agent visibility inside the same conversation

Skip it when:

- the interaction is short-lived and mostly stateless
- the host should own all compaction and memory policy
- you want pure automatic summarization rather than model-managed working memory

## Runnable Example

- [`examples/08-scratchpad.ts`](../../../examples/08-scratchpad.ts)
