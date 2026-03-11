import { describe, expect, test } from "bun:test";
import { createSummarizer } from "../summarizer.js";

describe("createSummarizer", () => {
  test("builds package-owned prompts and parses summary span responses", async () => {
    let prompt = "";

    const summarizer = createSummarizer({
      async summarize(nextPrompt) {
        prompt = nextPrompt;
        return JSON.stringify([
          {
            startId: "a1",
            endId: "a2",
            summary: "Captured the canonical conversation history",
          },
        ]);
      },
    });

    const result = await summarizer.summarize({
      transcript: {
        text: "<conversation><message id=\"a1\">Alpha</message><message id=\"a2\">Beta</message></conversation>",
        shortIdMap: new Map([
          ["a1", "record-1"],
          ["a2", "record-2"],
        ]),
        firstTranscriptId: "a1",
        lastTranscriptId: "a2",
      },
      targetTokens: 120,
      records: [
        { id: "record-1", role: "user", kind: "text", content: "Alpha" },
        { id: "record-2", role: "assistant", kind: "text", content: "Beta" },
      ],
      previousSummarySpans: [],
    });

    expect(prompt).toContain("replacement summary spans");
    expect(prompt).toContain('The first span must start at id "a1"');
    expect(prompt).toContain("Preserve attribution, routing, concrete facts, decisions, unresolved work, tool findings, and outcomes.");
    expect(result).toEqual([
      {
        startRecordId: "record-1",
        endRecordId: "record-2",
        summary: "Captured the canonical conversation history",
      },
    ]);
  });
});
