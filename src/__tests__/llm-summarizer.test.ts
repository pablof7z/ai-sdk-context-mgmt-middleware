import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

const mockGenerateText = mock();

mock.module("ai", () => ({
  generateText: mockGenerateText,
}));

import {
  SummarizationStrategy,
  buildDeterministicSummary,
  buildSummaryTranscript,
  createLlmSummarizer,
} from "../index.js";
import type {
  ContextManagementStrategyState,
  RemovedToolExchange,
} from "../types.js";

const estimator = {
  estimateMessage: () => 100,
  estimatePrompt: (prompt: LanguageModelV3Prompt) => prompt.length * 100,
};

function createMockState(prompt: LanguageModelV3Prompt): ContextManagementStrategyState & {
  capturedRemovedExchanges: RemovedToolExchange[];
} {
  const capturedRemovedExchanges: RemovedToolExchange[] = [];

  return {
    params: {
      prompt,
      providerOptions: {
        contextManagement: {
          conversationId: "conv-1",
          agentId: "agent-1",
        },
      },
    } as any,
    prompt,
    requestContext: { conversationId: "conv-1", agentId: "agent-1" },
    removedToolExchanges: [],
    pinnedToolCallIds: new Set<string>(),
    capturedRemovedExchanges,
    updatePrompt(newPrompt: LanguageModelV3Prompt) {
      (this as any).prompt = newPrompt;
    },
    updateParams() {},
    addRemovedToolExchanges(exchanges: RemovedToolExchange[]) {
      capturedRemovedExchanges.push(...exchanges);
    },
    addPinnedToolCallIds() {},
  };
}

describe("LLM-backed summarization", () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  test("buildSummaryTranscript preserves structured details", () => {
    const transcript = buildSummaryTranscript([
      { role: "system", content: "You are helpful." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "fs_read",
            input: { path: "/tmp/a.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "fs_read",
            output: { type: "text", value: "console.log('a');" },
          },
        ],
      },
    ]);

    expect(transcript).toContain("/tmp/a.ts");
    expect(transcript).toContain("fs_read#call-1");
    expect(transcript).toContain("console.log('a');");
  });

  test("createLlmSummarizer uses the provided model and falls back deterministically on empty output", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    const model = {
      specificationVersion: "v3",
      provider: "mock",
      modelId: "mock",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("unused");
      },
      doStream: async () => {
        throw new Error("unused");
      },
    } as any;

    const summarize = createLlmSummarizer({
      model,
    });

    const summary = await summarize([
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "Need help with parser.ts" }] },
    ]);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        model,
        maxOutputTokens: 1200,
        temperature: 0,
      })
    );
    expect(summary).toContain("Compressed history (deterministic fallback):");
    expect(summary).toContain("parser.ts");
  });

  test("SummarizationStrategy uses the model-backed helper when model is provided", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Key Findings\n- Parser issue in /tmp/parser.ts",
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    const strategy = new SummarizationStrategy({
      model: {
        specificationVersion: "v3",
        provider: "mock",
        modelId: "mock",
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("unused");
        },
        doStream: async () => {
          throw new Error("unused");
        },
      } as any,
      maxPromptTokens: 200,
      preserveRecentMessages: 1,
      estimator,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "old issue in /tmp/parser.ts" }] },
      { role: "assistant", content: [{ type: "text", text: "old diagnosis" }] },
      { role: "user", content: [{ type: "text", text: "latest request" }] },
    ];

    const state = createMockState(prompt);
    const result = await strategy.apply(state);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(state.prompt).toHaveLength(3);
    expect(state.prompt[1]).toEqual(
      expect.objectContaining({
        role: "system",
        content: "Key Findings\n- Parser issue in /tmp/parser.ts",
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        reason: "history-summarized",
        payloads: expect.objectContaining({
          messagesSummarizedCount: expect.any(Number),
          summaryCharCount: "Key Findings\n- Parser issue in /tmp/parser.ts".length,
        }),
      })
    );
  });

  test("SummarizationStrategy prefers summarize over model when both are provided", async () => {
    const summarize = mock(async () => "custom summary");

    const strategy = new SummarizationStrategy({
      summarize,
      model: {
        specificationVersion: "v3",
        provider: "mock",
        modelId: "mock",
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("unused");
        },
        doStream: async () => {
          throw new Error("unused");
        },
      } as any,
      maxPromptTokens: 200,
      preserveRecentMessages: 1,
      estimator,
    });

    const state = createMockState([
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "old request" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "text", text: "latest request" }] },
    ]);

    await strategy.apply(state);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(state.prompt[1]).toEqual(
      expect.objectContaining({
        role: "system",
        content: "custom summary",
      })
    );
  });

  test("SummarizationStrategy throws when neither summarize nor model is provided", () => {
    expect(() =>
      new SummarizationStrategy({
        maxPromptTokens: 200,
        estimator,
      })
    ).toThrow("SummarizationStrategy requires either summarize or model");
  });
});
