import { describe, test, expect } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { createDefaultEstimator } from "../token-estimator.js";

const estimator = createDefaultEstimator();

describe("createDefaultEstimator", () => {
  test("estimates string tokens at ~4 chars per token", () => {
    expect(estimator.estimateString("")).toBe(0);
    expect(estimator.estimateString("hello")).toBe(2); // 5/4 = 1.25 → ceil = 2
    expect(estimator.estimateString("a".repeat(100))).toBe(25);
  });

  test("estimates system message with overhead", () => {
    const msg: LanguageModelV3Message = { role: "system", content: "You are helpful." };
    // 16 chars / 4 = 4 tokens + 4 overhead = 8
    expect(estimator.estimateMessage(msg)).toBe(8);
  });

  test("estimates user message with text parts", () => {
    const msg: LanguageModelV3Message = {
      role: "user",
      content: [{ type: "text", text: "Hello, how are you?" }],
    };
    // 19 chars / 4 = 4.75 → ceil = 5 + 4 overhead = 9
    expect(estimator.estimateMessage(msg)).toBe(9);
  });

  test("estimates tool-call message", () => {
    const msg: LanguageModelV3Message = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c1", toolName: "search", args: { q: "test" } },
      ],
    };
    const tokens = estimator.estimateMessage(msg);
    expect(tokens).toBeGreaterThan(4); // at least overhead
  });

  test("estimates multiple messages", () => {
    const msgs: LanguageModelV3Message[] = [
      { role: "system", content: "System" },
      { role: "user", content: [{ type: "text", text: "User" }] },
    ];
    const total = estimator.estimateMessages(msgs);
    expect(total).toBe(estimator.estimateMessage(msgs[0]) + estimator.estimateMessage(msgs[1]));
  });

  test("handles empty messages array", () => {
    expect(estimator.estimateMessages([])).toBe(0);
  });
});
