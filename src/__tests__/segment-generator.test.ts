import { describe, expect, test } from "bun:test";
import {
  buildDefaultSegmentPrompt,
  createObjectSegmentGenerator,
  createSegmentGenerator,
  DEFAULT_SEGMENT_PROMPT_TEMPLATE,
} from "../segment-generator.js";
import type { SegmentGenerationInput } from "../types.js";

function makeInput(): SegmentGenerationInput {
  return {
    targetTokens: 120,
    messages: [
      { id: "msg-1", role: "user", entryType: "text", content: "first" },
      { id: "msg-2", role: "assistant", entryType: "text", content: "second" },
    ],
    previousSegments: [],
    transcript: {
      text: "<conversation><message id=\"a1\">first</message><message id=\"b2\">second</message></conversation>",
      shortIdMap: new Map([
        ["a1", "msg-1"],
        ["b2", "msg-2"],
      ]),
      firstId: "a1",
      lastId: "b2",
    },
  };
}

describe("segment-generator", () => {
  test("buildDefaultSegmentPrompt renders the default template", () => {
    const prompt = buildDefaultSegmentPrompt(makeInput());

    expect(DEFAULT_SEGMENT_PROMPT_TEMPLATE).toContain("{{targetTokens}}");
    expect(prompt).toContain("Target replacement budget: 120 tokens.");
    expect(prompt).toContain("Transcript ids run from a1 to b2.");
    expect(prompt).toContain("<conversation>");
  });

  test("buildDefaultSegmentPrompt includes recent prior summaries", () => {
    const prompt = buildDefaultSegmentPrompt({
      ...makeInput(),
      previousSegments: [
        { fromId: "older-1", toId: "older-2", compressed: "Older summary A" },
        { fromId: "older-3", toId: "older-4", compressed: "Older summary B" },
      ],
    });

    expect(prompt).toContain("Recent compressed context:");
    expect(prompt).toContain("[Previous summary 1] older-1..older-2: Older summary A");
    expect(prompt).toContain("[Previous summary 2] older-3..older-4: Older summary B");
  });

  test("createSegmentGenerator supports promptTemplate overrides", async () => {
    const prompts: string[] = [];
    const generator = createSegmentGenerator({
      promptTemplate: "Budget={{targetTokens}} First={{firstId}} Last={{lastId}} Transcript={{transcript}}",
      async generate(prompt) {
        prompts.push(prompt);
        return JSON.stringify({
          segments: [{ fromId: "a1", toId: "b2", compressed: "summary" }],
        });
      },
    });

    const result = await generator.generate(makeInput());

    expect(prompts[0]).toBe(
      "Budget=120 First=a1 Last=b2 Transcript=<conversation><message id=\"a1\">first</message><message id=\"b2\">second</message></conversation>"
    );
    expect(result).toEqual([{ fromId: "msg-1", toId: "msg-2", compressed: "summary" }]);
  });

  test("createSegmentGenerator lets buildPrompt fully override the default prompt", async () => {
    const prompts: string[] = [];
    const generator = createSegmentGenerator({
      promptTemplate: "should not be used",
      buildPrompt(input) {
        return `custom:${input.messages.length}`;
      },
      async generate(prompt) {
        prompts.push(prompt);
        return JSON.stringify({
          segments: [{ fromId: "a1", toId: "b2", compressed: "summary" }],
        });
      },
    });

    await generator.generate(makeInput());

    expect(prompts).toEqual(["custom:2"]);
  });

  test("createObjectSegmentGenerator supports structured responses", async () => {
    const prompts: string[] = [];
    const generator = createObjectSegmentGenerator({
      async generate(prompt) {
        prompts.push(prompt);
        return {
          segments: [
            {
              fromId: "a1",
              toId: "b2",
              compressed: "summary",
              metadata: { model: "test-model" },
            },
          ],
        };
      },
    });

    const result = await generator.generate(makeInput());

    expect(prompts[0]).toContain("Transcript:");
    expect(result).toEqual([
      {
        fromId: "msg-1",
        toId: "msg-2",
        compressed: "summary",
        metadata: { model: "test-model" },
      },
    ]);
  });
});
