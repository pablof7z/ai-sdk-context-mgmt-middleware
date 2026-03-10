import { describe, test, expect } from "bun:test";
import { createDefaultEstimator } from "../token-estimator.js";
import type { ContextMessage } from "../types.js";

const estimator = createDefaultEstimator();

describe("createDefaultEstimator", () => {
  test("estimates strings at roughly four chars per token", () => {
    expect(estimator.estimateString("")).toBe(0);
    expect(estimator.estimateString("hello")).toBe(2);
    expect(estimator.estimateString("a".repeat(100))).toBe(25);
  });

  test("estimates message overhead", () => {
    const message: ContextMessage = {
      id: "msg-1",
      role: "user",
      entryType: "text",
      content: "Hello, world!",
    };

    expect(estimator.estimateMessage(message)).toBe(8);
  });

  test("includes tool metadata in estimates", () => {
    const message: ContextMessage = {
      id: "call-1:result",
      role: "tool",
      entryType: "tool-result",
      content: "search output",
      toolCallId: "call-1",
      toolName: "search",
    };

    expect(estimator.estimateMessage(message)).toBeGreaterThan(8);
  });

  test("sums multiple messages", () => {
    const messages: ContextMessage[] = [
      { id: "s1", role: "system", entryType: "text", content: "System prompt" },
      { id: "u1", role: "user", entryType: "text", content: "User prompt" },
    ];

    expect(estimator.estimateMessages(messages)).toBe(
      estimator.estimateMessage(messages[0]) + estimator.estimateMessage(messages[1])
    );
  });
});
