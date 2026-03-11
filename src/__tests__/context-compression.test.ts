import { describe, test, expect } from "bun:test";
import { createCompressionCache } from "../cache.js";
import { contextCompression } from "../context-compression.js";
import type { ContextCompressionMessage } from "../types.js";

function makeMessages(): ContextCompressionMessage[] {
  return [
    { id: "msg-1", role: "user", content: [{ type: "text", text: "Plan the migration" }] },
    { id: "msg-2", role: "assistant", content: [{ type: "text", text: "Collecting the current state" }] },
    { id: "msg-3", role: "user", content: [{ type: "text", text: "Focus on compression and persistence" }] },
    { id: "msg-4", role: "assistant", content: [{ type: "text", text: "I will keep the latest turn intact" }] },
  ];
}

describe("contextCompression", () => {
  test("uses a segment store with an explicit conversation key", async () => {
    const store = new Map<string, any[]>();
    let generateCount = 0;

    const firstResult = await contextCompression({
      messages: makeMessages(),
      maxTokens: 40,
      compressionThreshold: 0,
      protectedTailCount: 1,
      conversationKey: "conv-1",
      segmentStore: {
        load(key) {
          return store.get(key) ?? [];
        },
        save(key, segments) {
          store.set(key, segments);
        },
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

    const secondResult = await contextCompression({
      messages: makeMessages(),
      maxTokens: 40,
      compressionThreshold: 0,
      protectedTailCount: 1,
      conversationKey: "conv-1",
      segmentStore: {
        load(key) {
          return store.get(key) ?? [];
        },
        save(key, segments) {
          store.set(key, segments);
        },
      },
    });

    expect(generateCount).toBe(1);
    expect(store.get("conv-1")).toHaveLength(1);
    expect(firstResult.messages).toEqual([
      { id: "segment:msg-1:msg-3", role: "user", content: "[Compressed history]\nstored summary", providerOptions: undefined },
      makeMessages()[3],
    ]);
    expect(secondResult.messages).toEqual(firstResult.messages);
  });

  test("preserves tool-call and tool-result adjacency at the protected tail boundary", async () => {
    const messages: ContextCompressionMessage[] = [
      { id: "msg-1", role: "user", content: [{ type: "text", text: "question" }] },
      {
        id: "msg-2",
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } }],
      },
      {
        id: "msg-3",
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "text", value: `tool output ${"x".repeat(200)}` },
        }],
      },
    ];

    const result = await contextCompression({
      messages,
      maxTokens: 500,
      compressionThreshold: 0,
      protectedTailCount: 1,
      segmentGenerator: {
        async generate({ messages: candidateMessages }) {
          return [{
            fromId: candidateMessages[0].id,
            toId: candidateMessages[candidateMessages.length - 1].id,
            compressed: "summary",
          }];
        },
      },
    });

    expect(result.messages).toEqual([
      { id: "segment:msg-1:msg-1", role: "user", content: "[Compressed history]\nsummary", providerOptions: undefined },
      messages[1],
      messages[2],
    ]);
  });

  test("does not leak shared cache results across compression configs", async () => {
    const cache = createCompressionCache();
    const messages: ContextCompressionMessage[] = [
      {
        id: "evt-tool-call-1",
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "fs_read", input: { q: "x" } }],
      },
      {
        id: "evt-tool-result-1",
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "fs_read",
          output: { type: "text", value: "y".repeat(800) },
        }],
      },
    ];

    const strictResult = await contextCompression({
      messages,
      maxTokens: 5_000,
      compressionThreshold: 1,
      cache,
      toolPolicy: () => ({ result: { policy: "remove" } }),
    });
    const relaxedResult = await contextCompression({
      messages,
      maxTokens: 5_000,
      compressionThreshold: 1,
      cache,
      toolPolicy: () => ({ result: { policy: "keep" } }),
    });

    expect(strictResult.messages).not.toEqual(messages);
    expect(relaxedResult.messages).toEqual(messages);
  });

  test("fails loudly on duplicate message ids", async () => {
    await expect(contextCompression({
      messages: [
        { id: "dup", role: "user", content: [{ type: "text", text: "one" }] },
        { id: "dup", role: "assistant", content: [{ type: "text", text: "two" }] },
      ],
      maxTokens: 100,
    })).rejects.toThrow('Duplicate message id "dup"');
  });

  test("requires conversationKey when segment persistence is configured", async () => {
    await expect(contextCompression({
      messages: makeMessages(),
      maxTokens: 100,
      segmentStore: {
        load() {
          return [];
        },
      },
    })).rejects.toThrow("conversationKey is required when segmentStore is configured");
  });

  test("renders retrieval placeholders with the configured tool and stable message id", async () => {
    const result = await contextCompression({
      messages: [
        {
          id: "evt-tool-call-1",
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "fs_read", input: { path: "/tmp/log.txt" } }],
        },
        {
          id: "evt-tool-result-1",
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: "c1",
            toolName: "fs_read",
            output: { type: "text", value: "x".repeat(3_000) },
          }],
        },
      ],
      maxTokens: 5_000,
      compressionThreshold: 1,
      retrievalToolName: "read_tool_output",
      retrievalToolArgName: "id",
      toolPolicy: () => ({ result: { policy: "remove" } }),
    });

    expect((result.messages[1].content[0] as any).output.value).toBe(
      '[Tool output removed. Use read_tool_output(id="evt-tool-result-1") to retrieve the full output.]'
    );
  });

  test("keeps middleware and low-level engine off the public index", async () => {
    const publicApi = await import("../index.js");

    expect("contextCompression" in publicApi).toBe(true);
    expect("prunePrompt" in publicApi).toBe(true);
    expect("summarizeConversation" in publicApi).toBe(true);
    expect("manageContext" in publicApi).toBe(false);
    expect("createContextManagementMiddleware" in publicApi).toBe(false);
    expect("contextManagement" in publicApi).toBe(false);
  });
});
