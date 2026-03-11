import { describe, expect, test } from "bun:test";
import { summarizeConversation } from "../summarize-conversation.js";
import type { ConversationRecord } from "../public-types.js";

function makeRecords(): ConversationRecord[] {
  return [
    { id: "record-1", role: "user", kind: "text", content: "Plan the migration" },
    { id: "record-2", role: "assistant", kind: "text", content: "Inspecting the current architecture" },
    { id: "record-3", role: "user", kind: "text", content: "Split history summaries from prompt pruning" },
    { id: "record-4", role: "assistant", kind: "text", content: "Keeping the latest exchange verbatim" },
  ];
}

describe("summarizeConversation", () => {
  test("generates and persists new summary spans", async () => {
    const stored = new Map<string, unknown[]>();

    const result = await summarizeConversation({
      records: makeRecords(),
      maxTokens: 40,
      summaryThreshold: 0,
      preservedTailCount: 1,
      conversationKey: "conv-1",
      summaryStore: {
        load(key) {
          return (stored.get(key) as ReturnType<typeof makeStoredSpanArray> | undefined) ?? [];
        },
        save(key, summarySpans) {
          stored.set(key, summarySpans);
        },
      },
      summarizer: {
        async summarize({ records }) {
          return [{
            startRecordId: records[0].id,
            endRecordId: records[2].id,
            summary: "Captured the initial migration discussion",
          }];
        },
      },
    });

    expect(result.newSummarySpans).toEqual([{
      startRecordId: "record-1",
      endRecordId: "record-3",
      summary: "Captured the initial migration discussion",
      createdAt: expect.any(Number),
      metadata: undefined,
    }]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: "segment:record-1:record-3",
      role: "user",
      kind: "summary",
      content: "[Compressed history]\nCaptured the initial migration discussion",
    });
    expect(result.records[1]).toMatchObject({
      id: "record-4",
      role: "assistant",
      kind: "text",
      content: "Keeping the latest exchange verbatim",
    });
    expect(stored.get("conv-1")).toEqual(result.appliedSummarySpans);
  });

  test("uses package-owned last-resort truncation when configured", async () => {
    const result = await summarizeConversation({
      records: makeRecords(),
      maxTokens: 40,
      summaryThreshold: 0,
      preservedTailCount: 1,
      summaryFailureMode: "last-resort-truncate",
      summarizer: {
        async summarize() {
          throw new Error("structured output failed");
        },
      },
    });

    expect(result.newSummarySpans).toHaveLength(1);
    expect(result.newSummarySpans[0]).toMatchObject({
      startRecordId: "record-1",
      endRecordId: "record-3",
      summary: "[Truncated 3 earlier records after summarization failed]",
    });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: "segment:record-1:record-3",
      role: "user",
      kind: "summary",
      content: "[Compressed history]\n[Truncated 3 earlier records after summarization failed]",
    });
  });
});

function makeStoredSpanArray() {
  return [{
    startRecordId: "record-1",
    endRecordId: "record-3",
    summary: "Captured the initial migration discussion",
  }];
}
