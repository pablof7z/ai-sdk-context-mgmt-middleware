import { describe, expect, test } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { createCompressionCache } from "../cache.js";
import { contextManagement } from "../middleware.js";
import { createDefaultEstimator } from "../token-estimator.js";

const PROMPT: LanguageModelV3Message[] = [
  {
    role: "user",
    content: [{ type: "text", text: "x".repeat(200) }],
  },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "search", args: {} }],
  },
  {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: "c1",
      toolName: "search",
      content: [{ type: "text", text: "y".repeat(800) }],
    }],
  } as any,
  {
    role: "user",
    content: [{ type: "text", text: "z".repeat(200) }],
  },
];

describe("contextManagement", () => {
  test("does not reuse cached output across middleware configs", async () => {
    const cache = createCompressionCache();

    const strictMiddleware = contextManagement({
      maxTokens: 50,
      ruleBasedThreshold: 0,
      llmThreshold: 1,
      protectedTailCount: 1,
      cache,
      toolOutput: {
        defaultPolicy: "remove",
        recentFullCount: 0,
        maxTokens: 10,
      },
    });

    const relaxedMiddleware = contextManagement({
      maxTokens: 5_000,
      ruleBasedThreshold: 0.99,
      protectedTailCount: 1,
      cache,
      toolOutput: {
        defaultPolicy: "keep",
        recentFullCount: 10,
        maxTokens: 1_000,
      },
    });

    const strictResult = await strictMiddleware.transformParams?.({
      params: { prompt: PROMPT } as any,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });
    const relaxedResult = await relaxedMiddleware.transformParams?.({
      params: { prompt: PROMPT } as any,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });

    expect(strictResult?.prompt).not.toEqual(PROMPT);
    expect(relaxedResult?.prompt).toEqual(PROMPT);
  });

  test("keeps tool-call and tool-result together when protecting the tail", async () => {
    const middleware = contextManagement({
      maxTokens: 80,
      ruleBasedThreshold: 0,
      llmThreshold: 0,
      protectedTailCount: 1,
      llmCompressor: {
        async compress() {
          return [{ role: "user", content: [{ type: "text", text: "summary" }] } as any];
        },
      },
    });

    const prompt: LanguageModelV3Message[] = [
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "search", args: { q: "x" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          content: [{ type: "text", text: "tool output " + "x".repeat(200) }],
        }],
      } as any,
    ];

    const result = await middleware.transformParams?.({
      params: { prompt } as any,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });

    expect(result?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "summary" }] },
      prompt[1],
      prompt[2],
    ]);
  });

  test("enforces the max token budget when compression is still insufficient", async () => {
    const estimator = createDefaultEstimator();
    const middleware = contextManagement({
      maxTokens: 20,
      ruleBasedThreshold: 0,
      protectedTailCount: 1,
    });

    const prompt: LanguageModelV3Message[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(200) }] },
      { role: "assistant", content: [{ type: "text", text: "y".repeat(200) }] },
      { role: "user", content: [{ type: "text", text: "z".repeat(200) }] },
    ];

    const result = await middleware.transformParams?.({
      params: { prompt } as any,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });

    expect(result?.prompt).not.toEqual(prompt);
    expect(estimator.estimateMessages(result?.prompt as LanguageModelV3Message[])).toBeLessThanOrEqual(20);
    expect(result?.prompt).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "[Earlier conversation truncated to fit token budget]" }],
      },
    ]);
  });
});
