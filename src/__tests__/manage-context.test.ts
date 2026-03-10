import { describe, test, expect } from "bun:test";
import { manageContext } from "../manage-context.js";
import type { ContextMessageInput, SegmentGenerator } from "../types.js";

function makeConversation(): ContextMessageInput[] {
  return [
    { role: "user", content: "Plan the migration" },
    { role: "assistant", content: "Collecting the current state" },
    { role: "user", content: "Focus on compression and persistence" },
    { role: "assistant", content: "I will keep the latest turn intact" },
  ];
}

describe("manageContext", () => {
  test("applies custom tool policy even below the segment-compression threshold", async () => {
    const messages: ContextMessageInput[] = [
      {
        role: "assistant",
        entryType: "tool-call",
        toolCallId: "call-1",
        toolName: "fs_write",
        content: `fs_write(${JSON.stringify({ path: "/tmp/file", content: "x".repeat(400) })})`,
      },
      {
        role: "tool",
        entryType: "tool-result",
        toolCallId: "call-1",
        toolName: "fs_write",
        content: "ok",
      },
      { role: "user", content: "Continue" },
    ];

    const result = await manageContext({
      messages,
      maxTokens: 5_000,
      compressionThreshold: 0.95,
      toolPolicy: ({ call }) => ({
        call: call && call.tokens > 50 ? { policy: "truncate", maxTokens: 24 } : undefined,
      }),
    });

    expect(result.newSegments).toHaveLength(0);
    expect(result.modifications.some((modification) => modification.type === "tool-call-truncated")).toBe(true);
    expect(result.messages.find((message) => message.entryType === "tool-call")?.content).toContain("[...truncated]");
  });

  test("reapplies existing segments on the next turn", async () => {
    const messages = makeConversation();
    const segmentGenerator: SegmentGenerator = {
      async generate({ messages: candidateMessages }) {
        return [{
          fromId: candidateMessages[0].id,
          toId: candidateMessages[candidateMessages.length - 1].id,
          compressed: "migration summary",
        }];
      },
    };

    const firstTurn = await manageContext({
      messages,
      maxTokens: 40,
      compressionThreshold: 0,
      protectedTailCount: 1,
      segmentGenerator,
    });

    const secondTurn = await manageContext({
      messages,
      maxTokens: 40,
      compressionThreshold: 0,
      protectedTailCount: 1,
      existingSegments: firstTurn.appliedSegments,
    });

    expect(firstTurn.newSegments).toHaveLength(1);
    expect(secondTurn.newSegments).toHaveLength(0);
    expect(secondTurn.messages.map((message) => message.content)).toEqual([
      "[Compressed history]\nmigration summary",
      "I will keep the latest turn intact",
    ]);
  });

  test("applies multiple generated segments", async () => {
    const messages = makeConversation();
    const segmentGenerator: SegmentGenerator = {
      async generate({ messages: candidateMessages }) {
        return [
          {
            fromId: candidateMessages[0].id,
            toId: candidateMessages[1].id,
            compressed: "segment one",
          },
          {
            fromId: candidateMessages[2].id,
            toId: candidateMessages[2].id,
            compressed: "segment two",
          },
        ];
      },
    };

    const result = await manageContext({
      messages,
      maxTokens: 40,
      compressionThreshold: 0,
      protectedTailCount: 1,
      segmentGenerator,
    });

    expect(result.newSegments).toHaveLength(2);
    expect(result.messages.map((message) => message.content)).toEqual([
      "[Compressed history]\nsegment one",
      "[Compressed history]\nsegment two",
      "I will keep the latest turn intact",
    ]);
  });

  test("enforces a hard token budget after all transforms", async () => {
    const result = await manageContext({
      messages: [
        { role: "user", content: "x".repeat(200) },
        { role: "assistant", content: "y".repeat(200) },
        { role: "user", content: "z".repeat(200) },
      ],
      maxTokens: 20,
      compressionThreshold: 1,
    });

    expect(result.stats.finalTokenEstimate).toBeLessThanOrEqual(20);
    expect(result.messages.map((message) => message.content)).toEqual([
      "[Earlier conversation truncated to fit token budget]",
    ]);
  });

  test("returns token statistics for the pipeline stages", async () => {
    const result = await manageContext({
      messages: makeConversation(),
      maxTokens: 100,
      compressionThreshold: 1,
    });

    expect(result.stats.originalTokenEstimate).toBeGreaterThan(0);
    expect(result.stats.postToolPolicyTokenEstimate).toBeGreaterThan(0);
    expect(result.stats.postSegmentTokenEstimate).toBeGreaterThan(0);
    expect(result.stats.finalTokenEstimate).toBeGreaterThan(0);
    expect(result.stats.finalTokenEstimate).toBeLessThanOrEqual(result.stats.postSegmentTokenEstimate);
  });
});
