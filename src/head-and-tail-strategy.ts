import {
  buildPromptFromSelectedIndices,
  collectToolExchanges,
  getPinnedMessageIndices,
} from "./prompt-utils.js";
import type {
  ContextManagementStrategy,
  ContextManagementStrategyExecution,
  ContextManagementStrategyState,
  HeadAndTailStrategyOptions,
  RemovedToolExchange,
} from "./types.js";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

const DEFAULT_HEAD_COUNT = 2;
const DEFAULT_TAIL_COUNT = 8;
const REASON = "head-and-tail";

export class HeadAndTailStrategy implements ContextManagementStrategy {
  readonly name = "head-and-tail";
  private readonly headCount: number;
  private readonly tailCount: number;

  constructor(options: HeadAndTailStrategyOptions = {}) {
    this.headCount = Math.max(0, Math.floor(options.headCount ?? DEFAULT_HEAD_COUNT));
    this.tailCount = Math.max(0, Math.floor(options.tailCount ?? DEFAULT_TAIL_COUNT));
  }

  apply(state: ContextManagementStrategyState): ContextManagementStrategyExecution {
    const prompt = state.prompt;

    const nonSystemIndices: number[] = [];
    for (let i = 0; i < prompt.length; i++) {
      if (prompt[i].role !== "system") {
        nonSystemIndices.push(i);
      }
    }

    if (nonSystemIndices.length <= this.headCount + this.tailCount) {
      return {
        reason: "within-head-tail-window",
        payloads: {
          headCount: this.headCount,
          tailCount: this.tailCount,
        },
      };
    }

    const exchanges = collectToolExchanges(prompt);

    // Determine head boundary: first headCount non-system messages
    let headEndNonSystem = this.headCount; // exclusive index into nonSystemIndices

    // Expand head boundary forward to avoid splitting tool exchanges
    for (;;) {
      let expanded = false;
      for (const exchange of exchanges.values()) {
        if (exchange.callMessageIndex === undefined) continue;

        const callNsIdx = nonSystemIndices.indexOf(exchange.callMessageIndex);
        const resultNsIndices = exchange.resultMessageIndices.map((ri) => nonSystemIndices.indexOf(ri)).filter((i) => i !== -1);

        // If the tool call is in the head but any result is outside the head (in the drop zone)
        if (callNsIdx !== -1 && callNsIdx < headEndNonSystem) {
          for (const rni of resultNsIndices) {
            if (rni >= headEndNonSystem && rni < nonSystemIndices.length - this.tailCount) {
              headEndNonSystem = rni + 1;
              expanded = true;
            }
          }
        }

        // If a result is in the head but the call is outside the head (in the drop zone)
        for (const rni of resultNsIndices) {
          if (rni < headEndNonSystem && callNsIdx >= headEndNonSystem && callNsIdx < nonSystemIndices.length - this.tailCount) {
            headEndNonSystem = callNsIdx + 1;
            expanded = true;
          }
        }
      }
      if (!expanded) break;
    }

    // Determine tail boundary: last tailCount non-system messages
    let tailStartNonSystem = nonSystemIndices.length - this.tailCount; // inclusive index into nonSystemIndices

    // Expand tail boundary backward to avoid splitting tool exchanges
    for (;;) {
      let expanded = false;
      for (const exchange of exchanges.values()) {
        if (exchange.callMessageIndex === undefined) continue;

        const callNsIdx = nonSystemIndices.indexOf(exchange.callMessageIndex);
        const resultNsIndices = exchange.resultMessageIndices.map((ri) => nonSystemIndices.indexOf(ri)).filter((i) => i !== -1);

        // If a result is in the tail but the call is in the drop zone
        for (const rni of resultNsIndices) {
          if (rni >= tailStartNonSystem && callNsIdx !== -1 && callNsIdx < tailStartNonSystem && callNsIdx >= headEndNonSystem) {
            tailStartNonSystem = callNsIdx;
            expanded = true;
          }
        }

        // If the call is in the tail but a result is in the drop zone
        if (callNsIdx !== -1 && callNsIdx >= tailStartNonSystem) {
          for (const rni of resultNsIndices) {
            if (rni < tailStartNonSystem && rni >= headEndNonSystem) {
              tailStartNonSystem = rni;
              expanded = true;
            }
          }
        }
      }
      if (!expanded) break;
    }

    // If boundaries overlap or meet, nothing to drop
    if (headEndNonSystem >= tailStartNonSystem) {
      return {
        reason: "head-tail-overlap",
        payloads: {
          headCount: this.headCount,
          tailCount: this.tailCount,
        },
      };
    }

    const keptIndices = getPinnedMessageIndices(prompt, state.pinnedToolCallIds);

    for (let i = 0; i < headEndNonSystem; i++) {
      keptIndices.add(nonSystemIndices[i]);
    }

    for (let i = tailStartNonSystem; i < nonSystemIndices.length; i++) {
      keptIndices.add(nonSystemIndices[i]);
    }

    const nextPrompt: LanguageModelV3Prompt = buildPromptFromSelectedIndices(prompt, keptIndices);

    // Build removed tool exchanges
    const nextExchanges = collectToolExchanges(nextPrompt);
    const removedToolExchanges: RemovedToolExchange[] = [];
    for (const exchange of exchanges.values()) {
      if (!nextExchanges.has(exchange.toolCallId)) {
        removedToolExchanges.push({
          toolCallId: exchange.toolCallId,
          toolName: exchange.toolName,
          reason: REASON,
        });
      }
    }

    state.updatePrompt(nextPrompt);
    state.addRemovedToolExchanges(removedToolExchanges);

    return {
      reason: "middle-trimmed",
      payloads: {
        headCount: this.headCount,
        tailCount: this.tailCount,
      },
    };
  }
}
