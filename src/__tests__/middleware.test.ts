import { describe, test, expect } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { createCompressionCache } from "../cache.js";
import { createContextManagementMiddleware } from "../middleware.js";

function makePrompt(): LanguageModelV3Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "Plan the migration" }] },
    { role: "assistant", content: [{ type: "text", text: "Collecting the current state" }] },
    { role: "user", content: [{ type: "text", text: "Focus on compression and persistence" }] },
    { role: "assistant", content: [{ type: "text", text: "I will keep the latest turn intact" }] },
  ];
}

describe("createContextManagementMiddleware", () => {
  test("uses a segment store with an explicit conversation key", async () => {
    const store = new Map<string, any[]>();
    let generateCount = 0;

    const middleware = createContextManagementMiddleware({
      maxTokens: 40,
      compressionThreshold: 0,
      protectedTailCount: 1,
      segmentStore: {
        load(key) {
          return store.get(key) ?? [];
        },
        save(key, segments) {
          store.set(key, segments);
        },
      },
      resolveConversationKey({ params }) {
        return ((params as any).providerOptions?.contextManagement?.conversationId ?? "") as string;
      },
      segmentGenerator: {
        async generate({ messages }) {
          generateCount++;
          return [{
            fromId: messages[0].id,
            toId: messages[messages.length - 1].id,
            compressed: "stored summary",
          }];
        },
      },
    });

    const params = {
      prompt: makePrompt(),
      providerOptions: {
        contextManagement: {
          conversationId: "conv-1",
        },
      },
    } as any;

    const firstResult = await middleware.transformParams?.({
      params,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });

    const secondResult = await middleware.transformParams?.({
      params,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });

    expect(generateCount).toBe(1);
    expect(store.get("conv-1")).toHaveLength(1);
    expect(firstResult?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "[Compressed history]\nstored summary" }] },
      makePrompt()[3],
    ]);
    expect(secondResult?.prompt).toEqual(firstResult?.prompt);
  });

  test("preserves tool-call and tool-result adjacency at the protected tail boundary", async () => {
    const middleware = createContextManagementMiddleware({
      maxTokens: 500,
      compressionThreshold: 0,
      protectedTailCount: 1,
      segmentGenerator: {
        async generate({ messages }) {
          return [{
            fromId: messages[0].id,
            toId: messages[messages.length - 1].id,
            compressed: "summary",
          }];
        },
      },
    });

    const prompt: LanguageModelV3Message[] = [
      { role: "user", content: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "text", value: `tool output ${"x".repeat(200)}` },
        }],
      },
    ];

    const result = await middleware.transformParams?.({
      params: { prompt } as any,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });

    expect(result?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "[Compressed history]\nsummary" }] },
      prompt[1],
      prompt[2],
    ]);
  });

  test("does not leak shared cache results across middleware configs", async () => {
    const cache = createCompressionCache();
    const prompt: LanguageModelV3Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "fs_read", input: { q: "x" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "fs_read",
          output: { type: "text", value: "y".repeat(800) },
        }],
      },
    ];

    const strictMiddleware = createContextManagementMiddleware({
      maxTokens: 5_000,
      compressionThreshold: 1,
      cache,
      toolPolicy: () => ({ result: { policy: "remove" } }),
    });

    const relaxedMiddleware = createContextManagementMiddleware({
      maxTokens: 5_000,
      compressionThreshold: 1,
      cache,
      toolPolicy: () => ({ result: { policy: "keep" } }),
    });

    const strictResult = await strictMiddleware.transformParams?.({
      params: { prompt } as any,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });
    const relaxedResult = await relaxedMiddleware.transformParams?.({
      params: { prompt } as any,
      type: "generate-text" as any,
      model: { provider: "test", modelId: "shared" } as any,
    });

    expect(strictResult?.prompt).not.toEqual(prompt);
    expect(relaxedResult?.prompt).toEqual(prompt);
  });
});
