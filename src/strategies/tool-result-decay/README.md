# ToolResultDecayStrategy

Replaces oversized tool outputs with placeholders based on age and tool-context pressure while preserving the surrounding tool-call structure.

The strategy is always-on. Total prompt size is telemetry, not an activation gate.

## What Changes In The Prompt

- newest tool results stay verbatim
- low-pressure tool sessions decay slowly even at deeper depths
- older or higher-pressure large results become placeholders
- smaller over-budget payloads stay intact instead of being partially shortened

## What The Agent Gets

- recent observations stay detailed
- old reasoning chains remain understandable
- pressure ramps up only when tool inputs and outputs actually consume significant context
- reminder delivery can surface a forecast of which tool-call IDs are next at risk

## Decay Shape

The strategy uses:

`effectiveDepth = depth * pressureFactor(toolContextTokens)`

The default anchors are:

- `100 -> 0.05`
- `5_000 -> 1`
- `50_000 -> 5`

So very small tool payloads can survive for many turns, around `~5k` tool tokens behaves close to the classic depth-only curve, and `~50k` tool tokens starts decaying even shallow history.

## Important Options

- `maxResultTokens`
  Sets the base per-result budget before pressure/depth are applied. Default: `200`.
- `placeholderMinSourceTokens`
  Minimum estimated size of a tool input or output before placeholdering is allowed. Smaller payloads stay intact instead. Default: `800`.
- `pressureAnchors`
  Custom `(toolTokens, depthFactor)` control points for the pressure curve.
- `warningForecastExtraTokens`
  Extra tool-context tokens to assume when forecasting "use it or lose it" warnings. Default: `10_000`.
- `placeholder`
  String or formatter function used for placeholder text.
- `decayInputs`
  Whether tool-call inputs decay alongside tool results. Default: `true`.

## Reminder Attributes

When reminder delivery is enabled, decay warnings include:

- `tool_call_ids`
- `placeholder_ids`
- `forecast_extra_tool_tokens`
- `forecast_tool_context_tokens`

## Runnable Example

- [`examples/02-tool-result-decay.ts`](../../../examples/02-tool-result-decay.ts)
