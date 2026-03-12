import { describe, test, expect } from "bun:test";
import { applyToolPolicy, defaultToolPolicy } from "../rule-based-compressor.js";
import { createDefaultEstimator } from "../token-estimator.js";
import { normalizeMessages } from "../messages.js";
import type { ContextMessageInput } from "../types.js";

const estimator = createDefaultEstimator();

function makeMessages(): ContextMessageInput[] {
  return [
    {
      id: "msg-1",
      role: "assistant",
      entryType: "tool-call",
      toolCallId: "c1",
      toolName: "fs_write",
      content: `fs_write(${JSON.stringify({ path: "/tmp/output.txt", content: "x".repeat(800) })})`,
    },
    {
      id: "msg-2",
      role: "tool",
      entryType: "tool-result",
      toolCallId: "c1",
      toolName: "fs_write",
      content: "ok",
    },
    {
      id: "msg-3",
      role: "assistant",
      entryType: "tool-call",
      toolCallId: "c2",
      toolName: "fs_read",
      content: 'fs_read({"path":"/tmp/output.txt"})',
    },
    {
      id: "msg-4",
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
        { id: "msg-user", role: "user", content: "Hello" },
        { id: "msg-assistant", role: "assistant", content: "Hi" },
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

  test("defaultToolPolicy preserves depth=0 and truncates depth=1 result that exceeds budget", async () => {
    // makeMessages() has fs_write (depth=1 in 4-message set) + fs_read (depth=0).
    // With a 3-exchange set: fs_write=depth=2, fs_read=depth=1, search=depth=0.
    const messages = normalizeMessages([
      ...makeMessages(),
      {
        id: "msg-5",
        role: "assistant",
        entryType: "tool-call",
        toolCallId: "c3",
        toolName: "search",
        content: 'search({"q":"recent"})',
      },
      {
        id: "msg-6",
        role: "tool",
        entryType: "tool-result",
        toolCallId: "c3",
        toolName: "search",
        content: "recent result",
      },
    ]);

    // maxContextTokens=1000: depth=1 result allowance = floor(1000 * 0.10 / 1) = 100 tokens.
    // fs_read result is "y"*600 ≈ 150 tokens → truncated.
    // search result at depth=0 → always preserved.
    const result = await applyToolPolicy(messages, {
      estimator,
      currentTokenEstimate: estimator.estimateMessages(messages),
      maxContextTokens: 1_000,
      toolPolicy: defaultToolPolicy,
    });

    expect(result.modifications.some((modification) => modification.type === "tool-result-truncated")).toBe(true);
    expect(result.messages[5].content).toBe("recent result");
  });

  test("defaultToolPolicy truncates heavy results (> 20% of context) to a minimal stub after depth=0", async () => {
    const maxContextTokens = 10_000;
    // 30% of context — qualifies as "heavy"
    const heavyContent = "x".repeat(Math.floor(maxContextTokens * 0.30 * 4));

    const messages = normalizeMessages([
      {
        id: "msg-1",
        role: "assistant",
        entryType: "tool-call",
        toolCallId: "c1",
        toolName: "take_screenshot",
        content: "take_screenshot({})",
      },
      {
        id: "msg-2",
        role: "tool",
        entryType: "tool-result",
        toolCallId: "c1",
        toolName: "take_screenshot",
        content: heavyContent,
      },
      // More recent exchange pushes screenshot to depth=1
      {
        id: "msg-3",
        role: "assistant",
        entryType: "tool-call",
        toolCallId: "c2",
        toolName: "fs_read",
        content: 'fs_read({"path":"/notes.txt","description":"read notes"})',
      },
      {
        id: "msg-4",
        role: "tool",
        entryType: "tool-result",
        toolCallId: "c2",
        toolName: "fs_read",
        content: "some notes",
      },
    ]);

    const result = await applyToolPolicy(messages, {
      estimator,
      currentTokenEstimate: estimator.estimateMessages(messages),
      maxContextTokens,
      toolPolicy: defaultToolPolicy,
    });

    // Heavy screenshot at depth=1 is truncated to a stub (never removed entirely)
    expect(result.modifications.some((m) => m.type === "tool-result-truncated")).toBe(true);
    expect(result.modifications.some((m) => m.type === "tool-result-removed")).toBe(false);
    // The truncated content should be much shorter than the original
    expect(result.messages[1].content.length).toBeLessThan(heavyContent.length / 10);
    // Most recent result at depth=0 is preserved
    expect(result.messages[3].content).toBe("some notes");
  });

  test("defaultToolPolicy keeps small results for many exchanges", async () => {
    // Build 10 exchanges all returning tiny results
    const exchangeMessages: ContextMessageInput[] = [];
    for (let i = 0; i < 10; i++) {
      exchangeMessages.push(
        {
          id: `call-${i}`,
          role: "assistant",
          entryType: "tool-call",
          toolCallId: `c${i}`,
          toolName: "fs_read",
          content: `fs_read({"path":"/f${i}.txt"})`,
        },
        {
          id: `result-${i}`,
          role: "tool",
          entryType: "tool-result",
          toolCallId: `c${i}`,
          toolName: "fs_read",
          content: "ok",  // ~1 token — fits budget at any depth with 100k context
        }
      );
    }

    const result = await applyToolPolicy(normalizeMessages(exchangeMessages), {
      estimator,
      currentTokenEstimate: estimator.estimateMessages(normalizeMessages(exchangeMessages)),
      maxContextTokens: 100_000,
      toolPolicy: defaultToolPolicy,
    });

    // No result should be truncated — all are tiny
    const resultMods = result.modifications.filter(
      (m) => m.type === "tool-result-truncated"
    );
    expect(resultMods).toHaveLength(0);
  });

  test("uses the truncation hook result for tool results", async () => {
    const messages = normalizeMessages(makeMessages());
    const result = await applyToolPolicy(messages, {
      estimator,
      currentTokenEstimate: estimator.estimateMessages(messages),
      maxContextTokens: 1_000,
      toolPolicy: () => ({ result: { policy: "truncate", maxTokens: 0 } }),
      onToolContentTruncated: async (event) => `hook:${event.entryType}:${event.toolCallId}`,
    });

    expect(result.messages[1].content).toBe("hook:tool-result:c1");
    expect(result.messages[3].content).toBe("hook:tool-result:c2");
  });

  test("beforeToolCompression can override the proposed compression plan", async () => {
    const messages = normalizeMessages(makeMessages());

    const result = await applyToolPolicy(messages, {
      estimator,
      currentTokenEstimate: estimator.estimateMessages(messages),
      maxContextTokens: 1_000,
      toolPolicy: () => ({ result: { policy: "truncate", maxTokens: 0 } }),
      beforeToolCompression: (entries) => entries.map((entry) => (
        entry.toolName === "fs_read"
          ? { ...entry, decision: { policy: "keep" } }
          : entry
      )),
      onToolContentTruncated: async () => "should-not-be-used",
    });

    expect(result.modifications.map((modification) => modification.type)).toEqual([
      "tool-result-truncated",
    ]);
    expect(result.messages[1].content).toBe("should-not-be-used");
    expect(result.messages[3].content).toBe("y".repeat(600));
  });
});
