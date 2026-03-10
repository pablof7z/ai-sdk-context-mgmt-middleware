import { describe, test, expect } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { applyRuleBasedCompression } from "../rule-based-compressor.js";
import { createDefaultEstimator } from "../token-estimator.js";

const estimator = createDefaultEstimator();

function makeToolCallMsg(toolName: string, toolCallId: string): LanguageModelV3Message {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, args: {} }],
  };
}

function makeToolResultMsg(toolCallId: string, text: string, toolName = "search"): LanguageModelV3Message {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
      },
    ],
  } as any;
}

describe("applyRuleBasedCompression", () => {
  test("passes through messages without tool results", () => {
    const messages: LanguageModelV3Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
    ];

    const result = applyRuleBasedCompression(messages, {
      estimator,
      toolOutput: {
        defaultPolicy: "truncate",
        maxTokens: 50,
        recentFullCount: 2,
        toolOverrides: {},
      },
    });

    expect(result.messages).toEqual(messages);
    expect(result.modifications).toHaveLength(0);
  });

  test("truncates old tool results while keeping recent ones", () => {
    const longText = "x".repeat(1000);
    const messages: LanguageModelV3Message[] = [
      makeToolCallMsg("search", "c1"),
      makeToolResultMsg("c1", longText),
      makeToolCallMsg("search", "c2"),
      makeToolResultMsg("c2", "short result"),
    ];

    const result = applyRuleBasedCompression(messages, {
      estimator,
      toolOutput: {
        defaultPolicy: "truncate",
        maxTokens: 50,
        recentFullCount: 1,
        toolOverrides: {},
      },
    });

    // First tool result should be truncated
    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0].type).toBe("tool-output-truncated");

    // Second (recent) should be intact
    const lastToolMsg = result.messages.filter((m) => m.role === "tool").pop() as any;
    const text = lastToolMsg.content[0].content[0].text;
    expect(text).toBe("short result");
  });

  test("removes tool outputs with 'remove' policy", () => {
    const messages: LanguageModelV3Message[] = [
      makeToolCallMsg("web_search", "c1"),
      makeToolResultMsg("c1", "lots of web content here that we don't need", "web_search"),
    ];

    const result = applyRuleBasedCompression(messages, {
      estimator,
      toolOutput: {
        defaultPolicy: "truncate",
        maxTokens: 50,
        recentFullCount: 0,
        toolOverrides: { web_search: "remove" },
      },
    });

    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0].type).toBe("tool-output-removed");

    const toolMsg = result.messages.find((m) => m.role === "tool") as any;
    expect(toolMsg.content[0].content[0].text).toBe("[Tool output removed for brevity]");
  });

  test("keeps tool outputs with 'keep' policy", () => {
    const longText = "x".repeat(1000);
    const messages: LanguageModelV3Message[] = [
      makeToolCallMsg("important_tool", "c1"),
      makeToolResultMsg("c1", longText, "important_tool"),
    ];

    const result = applyRuleBasedCompression(messages, {
      estimator,
      toolOutput: {
        defaultPolicy: "keep",
        maxTokens: 50,
        recentFullCount: 0,
        toolOverrides: {},
      },
    });

    expect(result.modifications).toHaveLength(0);
    expect(result.messages).toEqual(messages);
  });

  test("applies per-tool overrides over default policy", () => {
    const longText = "x".repeat(1000);
    const messages: LanguageModelV3Message[] = [
      makeToolCallMsg("keep_me", "c1"),
      makeToolResultMsg("c1", longText, "keep_me"),
      makeToolCallMsg("remove_me", "c2"),
      makeToolResultMsg("c2", longText, "remove_me"),
    ];

    const result = applyRuleBasedCompression(messages, {
      estimator,
      toolOutput: {
        defaultPolicy: "truncate",
        maxTokens: 50,
        recentFullCount: 0,
        toolOverrides: { keep_me: "keep", remove_me: "remove" },
      },
    });

    // keep_me should be untouched
    const keepMod = result.modifications.find((m) => m.toolName === "keep_me");
    expect(keepMod).toBeUndefined();

    // remove_me should be removed
    const removeMod = result.modifications.find((m) => m.toolName === "remove_me");
    expect(removeMod).toBeDefined();
    expect(removeMod!.type).toBe("tool-output-removed");
  });

  test("handles empty messages array", () => {
    const result = applyRuleBasedCompression([], {
      estimator,
      toolOutput: {
        defaultPolicy: "truncate",
        maxTokens: 50,
        recentFullCount: 2,
        toolOverrides: {},
      },
    });

    expect(result.messages).toHaveLength(0);
    expect(result.modifications).toHaveLength(0);
  });
});
