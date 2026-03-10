import { describe, test, expect } from "bun:test";
import { applyToolOutputPolicy } from "../rule-based-compressor.js";
import { createDefaultEstimator } from "../token-estimator.js";
import { normalizeMessages } from "../messages.js";
import type { ContextMessageInput } from "../types.js";

const estimator = createDefaultEstimator();

function makeMessages(): ContextMessageInput[] {
  return [
    {
      role: "assistant",
      entryType: "tool-call",
      toolCallId: "c1",
      toolName: "search",
      content: 'search({"q":"first"})',
    },
    {
      role: "tool",
      entryType: "tool-result",
      toolCallId: "c1",
      toolName: "search",
      content: "x".repeat(500),
    },
    {
      role: "assistant",
      entryType: "tool-call",
      toolCallId: "c2",
      toolName: "search",
      content: 'search({"q":"second"})',
    },
    {
      role: "tool",
      entryType: "tool-result",
      toolCallId: "c2",
      toolName: "search",
      content: "recent result",
    },
  ];
}

describe("applyToolOutputPolicy", () => {
  test("passes through messages without tool results", async () => {
    const result = await applyToolOutputPolicy(
      normalizeMessages([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]),
      {
        estimator,
        toolOutput: {
          defaultPolicy: "truncate",
          maxTokens: 50,
          recentFullCount: 2,
          toolOverrides: {},
        },
      }
    );

    expect(result.modifications).toHaveLength(0);
    expect(result.messages.map((message) => message.content)).toEqual(["Hello", "Hi"]);
  });

  test("truncates older tool results while keeping recent ones", async () => {
    const result = await applyToolOutputPolicy(normalizeMessages(makeMessages()), {
      estimator,
      toolOutput: {
        defaultPolicy: "truncate",
        maxTokens: 20,
        recentFullCount: 1,
        toolOverrides: {},
      },
    });

    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0].type).toBe("tool-output-truncated");
    expect(result.messages[1].content).toContain("[...truncated]");
    expect(result.messages[3].content).toBe("recent result");
  });

  test("removes tool output with an override", async () => {
    const result = await applyToolOutputPolicy(normalizeMessages(makeMessages()), {
      estimator,
      toolOutput: {
        defaultPolicy: "keep",
        maxTokens: 20,
        recentFullCount: 0,
        toolOverrides: { search: "remove" },
      },
    });

    expect(result.modifications).toHaveLength(2);
    expect(result.messages[1].content).toBe("[Tool output removed for brevity]");
  });

  test("uses the truncation hook result when provided", async () => {
    const result = await applyToolOutputPolicy(normalizeMessages(makeMessages()), {
      estimator,
      toolOutput: {
        defaultPolicy: "remove",
        maxTokens: 20,
        recentFullCount: 0,
        toolOverrides: {},
      },
      onToolOutputTruncated: async (event) => `hook:${event.toolCallId}`,
    });

    expect(result.messages[1].content).toBe("hook:c1");
    expect(result.messages[3].content).toBe("hook:c2");
  });
});
