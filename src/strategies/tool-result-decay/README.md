# ToolResultDecayStrategy

Compresses tool outputs by age and tool-context pressure while preserving the surrounding tool-call structure.

## What Changes In The Prompt

- newest tool results stay verbatim
- low-pressure tool sessions decay slowly even at deeper depths
- medium-age or high-pressure results are truncated
- the oldest or highest-pressure results become placeholders

## What The Agent Gets

- recent observations stay detailed
- old reasoning chains remain understandable
- pressure ramps up only when tool inputs and outputs actually consume significant context
- reminder sinks can receive a forecast of which tool-call IDs are next at risk

## Decay Shape

The strategy uses:

`effectiveDepth = depth * pressureFactor(toolContextTokens)`

The default anchors are:

- `100 -> 0.05`
- `5_000 -> 1`
- `50_000 -> 5`

So very small tool payloads can survive for many turns, around `~5k` tool tokens behaves close to the classic depth-only curve, and `~50k` tool tokens starts decaying even shallow history.

## Important Options

- `truncatedMaxTokens`
  Sets the base truncation window before pressure/depth are applied. Default: `200`.
- `placeholderFloorTokens`
  Below this remaining budget, results become placeholders instead of prefixes. Default: `20`.
- `pressureAnchors`
  Custom `(toolTokens, depthFactor)` control points for the pressure curve.
- `warningForecastExtraTokens`
  Extra tool-context tokens to assume when forecasting "use it or lose it" warnings. Default: `10_000`.
- `placeholder`
  String or formatter function used for both truncated headers and placeholders.
- `decayInputs`
  Whether tool-call inputs decay alongside tool results. Default: `true`.

## Reminder Attributes

When a reminder sink is configured, decay warnings include:

- `tool_call_ids`
- `truncate_ids`
- `placeholder_ids`
- `forecast_extra_tool_tokens`
- `forecast_tool_context_tokens`

## Runnable Example

- [`examples/02-tool-result-decay.ts`](../../../examples/02-tool-result-decay.ts)
