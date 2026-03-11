import { describe, expect, test } from "bun:test";
import { prunePrompt } from "../prune-prompt.js";
import type { PromptMessage } from "../public-types.js";

describe("prunePrompt", () => {
  test("applies existing summary spans through sourceRecordId", async () => {
    const messages: PromptMessage[] = [
      {
        id: "prompt-1",
        sourceRecordId: "record-1",
        role: "user",
        content: [{ type: "text", text: "Initial request" }],
      },
      {
        id: "prompt-2",
        sourceRecordId: "record-2",
        role: "assistant",
        content: [{ type: "text", text: "Investigating" }],
      },
      {
        id: "prompt-3",
        sourceRecordId: "record-3",
        role: "user",
        content: [{ type: "text", text: "Please keep going" }],
      },
    ];

    const result = await prunePrompt({
      messages,
      maxTokens: 200,
      pruningThreshold: 0,
      preservedTailCount: 1,
      existingSummarySpans: [{
        startRecordId: "record-1",
        endRecordId: "record-2",
        summary: "Earlier exchange summarized",
      }],
    });

    expect(result.appliedSummarySpans).toEqual([{
      startRecordId: "record-1",
      endRecordId: "record-2",
      summary: "Earlier exchange summarized",
      createdAt: undefined,
      metadata: undefined,
    }]);
    expect(result.messages).toEqual([
      {
        id: "segment:record-1:record-2",
        role: "user",
        content: "[Compressed history]\nEarlier exchange summarized",
        providerOptions: undefined,
      },
      messages[2],
    ]);
  });

  test("considers priorContextTokens when trimming prompt tool output", async () => {
    const messages: PromptMessage[] = [
      {
        id: "prompt-tool-call",
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "fs_read", input: { path: "/tmp/log.txt" } }],
      },
      {
        id: "prompt-tool-result",
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "fs_read",
          output: { type: "text", value: "x".repeat(3_000) },
        }],
      },
    ];

    const relaxed = await prunePrompt({
      messages,
      maxTokens: 5_000,
      pruningThreshold: 1,
      promptToolPolicy: () => ({ result: { policy: "keep" } }),
    });
    const pressured = await prunePrompt({
      messages,
      maxTokens: 5_000,
      pruningThreshold: 1,
      priorContextTokens: 4_900,
      promptToolPolicy: ({ currentTokenEstimate, maxContextTokens }) => ({
        result: currentTokenEstimate > maxContextTokens
          ? { policy: "remove" }
          : { policy: "keep" },
      }),
      retrievalToolName: "fetch_tool_output",
      retrievalToolArgName: "id",
    });

    expect(relaxed.messages).toEqual(messages);
    expect((pressured.messages[1].content[0] as { output: { value: string } }).output.value).toBe(
      '[Tool output removed. Use fetch_tool_output(id="prompt-tool-result") to retrieve the full output.]'
    );
  });
});
