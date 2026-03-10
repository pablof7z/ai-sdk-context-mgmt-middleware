import { describe, test, expect } from "bun:test";
import { applyToolPolicy, defaultToolPolicy } from "../rule-based-compressor.js";
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
      toolName: "fs_write",
      content: `fs_write(${JSON.stringify({ path: "/tmp/output.txt", content: "x".repeat(800) })})`,
    },
    {
      role: "tool",
      entryType: "tool-result",
      toolCallId: "c1",
      toolName: "fs_write",
      content: "ok",
    },
    {
      role: "assistant",
      entryType: "tool-call",
      toolCallId: "c2",
      toolName: "fs_read",
      content: 'fs_read({"path":"/tmp/output.txt"})',
    },
    {
      role: "tool",
      entryType: "tool-result",
      toolCallId: "c2",
      toolName: "fs_read",
      content: "y".repeat(600),
    },
  ];
}

describe("applyToolPolicy", () => {
  test("passes through messages without tool entries", async () => {
    const result = await applyToolPolicy(
      normalizeMessages([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]),
      {
        estimator,
        currentTokenEstimate: 20,
        maxContextTokens: 100,
      }
    );

    expect(result.modifications).toHaveLength(0);
    expect(result.messages.map((message) => message.content)).toEqual(["Hello", "Hi"]);
  });

  test("lets a custom policy truncate a tool call based on call-side size", async () => {
    const messages = normalizeMessages(makeMessages());
    const result = await applyToolPolicy(messages, {
      estimator,
      currentTokenEstimate: estimator.estimateMessages(messages),
      maxContextTokens: 5_000,
      toolPolicy: ({ call, result }) => ({
        call: call && call.tokens > 100 ? { policy: "truncate", maxTokens: 24 } : undefined,
        result: result && result.tokens > 100 ? { policy: "truncate", maxTokens: 32 } : undefined,
      }),
    });

    expect(result.modifications.map((modification) => modification.type)).toEqual([
      "tool-call-truncated",
      "tool-result-truncated",
    ]);
    expect(result.messages[0].content).toContain("[...truncated]");
    expect(result.messages[3].content).toContain("[...truncated]");
  });

  test("defaultToolPolicy uses burial depth and result size", async () => {
    const messages = normalizeMessages([
      ...makeMessages(),
      {
        role: "assistant",
        entryType: "tool-call",
        toolCallId: "c3",
        toolName: "search",
        content: 'search({"q":"recent"})',
      },
      {
        role: "tool",
        entryType: "tool-result",
        toolCallId: "c3",
        toolName: "search",
        content: "recent result",
      },
    ]);

    const result = await applyToolPolicy(messages, {
      estimator,
      currentTokenEstimate: estimator.estimateMessages(messages),
      maxContextTokens: 1_000,
      toolPolicy: defaultToolPolicy,
    });

    expect(result.modifications.some((modification) => modification.type === "tool-result-truncated")).toBe(true);
    expect(result.messages[5].content).toBe("recent result");
  });

  test("uses the truncation hook result for tool results", async () => {
    const messages = normalizeMessages(makeMessages());
    const result = await applyToolPolicy(messages, {
      estimator,
      currentTokenEstimate: estimator.estimateMessages(messages),
      maxContextTokens: 1_000,
      toolPolicy: () => ({ result: { policy: "remove" } }),
      onToolContentTruncated: async (event) => `hook:${event.entryType}:${event.toolCallId}`,
    });

    expect(result.messages[1].content).toBe("hook:tool-result:c1");
    expect(result.messages[3].content).toBe("hook:tool-result:c2");
  });
});
