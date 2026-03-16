import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { SummarizationStrategy } from "../index.js";
import type {
  ContextManagementStrategyState,
  RemovedToolExchange,
} from "../types.js";

const estimator = {
  estimateMessage: () => 100,
  estimatePrompt: (prompt: LanguageModelV3Prompt) => prompt.length * 100,
};

function createMockState(prompt: LanguageModelV3Prompt, pinnedIds: string[] = []): ContextManagementStrategyState & {
  capturedRemovedExchanges: RemovedToolExchange[];
} {
  const capturedRemovedExchanges: RemovedToolExchange[] = [];
  const pinnedToolCallIds = new Set(pinnedIds);

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
    pinnedToolCallIds,
    capturedRemovedExchanges,
    updatePrompt(newPrompt: LanguageModelV3Prompt) {
      (this as any).prompt = newPrompt;
    },
    updateParams() {},
    addRemovedToolExchanges(exchanges: RemovedToolExchange[]) {
      capturedRemovedExchanges.push(...exchanges);
    },
    addPinnedToolCallIds(toolCallIds: string[]) {
      for (const id of toolCallIds) {
        pinnedToolCallIds.add(id);
      }
    },
  };
}

function makeSummarize() {
  const calls: LanguageModelV3Message[][] = [];
  const fn = async (messages: LanguageModelV3Message[]) => {
    calls.push(messages);
    return `summary of ${messages.length} messages`;
  };
  return { fn, calls };
}

describe("SummarizationStrategy", () => {
  test("no-op when under token threshold", async () => {
    const { fn: summarize, calls } = makeSummarize();
    const strategy = new SummarizationStrategy({
      summarize,
      maxPromptTokens: 1000,
      estimator,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];

    const state = createMockState(prompt);
    const result = await strategy.apply(state);

    expect(calls).toHaveLength(0);
    // Prompt unchanged (same references since updatePrompt was never called)
    expect(state.prompt).toEqual(prompt);
  });

  test("summarizes older messages when over threshold", async () => {
    const { fn: summarize, calls } = makeSummarize();
    const strategy = new SummarizationStrategy({
      summarize,
      maxPromptTokens: 200,
      preserveRecentMessages: 2,
      estimator,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "old message 1" }] },
      { role: "assistant", content: [{ type: "text", text: "old reply 1" }] },
      { role: "user", content: [{ type: "text", text: "old message 2" }] },
      { role: "assistant", content: [{ type: "text", text: "old reply 2" }] },
      { role: "user", content: [{ type: "text", text: "recent question" }] },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];

    const state = createMockState(prompt);
    const result = await strategy.apply(state);

    expect(calls).toHaveLength(1);
    // 6 non-system messages total, preserveRecentMessages=2, so 4 messages summarized
    expect(calls[0]).toHaveLength(4);

    // Result: system + summary + 2 tail messages
    expect(state.prompt).toHaveLength(4);
    expect(state.prompt[0].role).toBe("system");
    expect(state.prompt[0].content).toBe("You are helpful.");
    expect(state.prompt[1].role).toBe("system");
    expect(state.prompt[1].content).toBe("summary of 4 messages");
    expect(state.prompt[2].role).toBe("user");
    expect(state.prompt[3].role).toBe("assistant");
    expect(result).toEqual({
      reason: "history-summarized",
      workingTokenBudget: 200,
      payloads: expect.objectContaining({
        estimatedTokens: 700,
        preserveRecentMessages: 2,
        messagesSummarizedCount: 4,
        summaryCharCount: "summary of 4 messages".length,
      }),
    });
  });

  test("keeps tail messages intact", async () => {
    const { fn: summarize } = makeSummarize();
    const strategy = new SummarizationStrategy({
      summarize,
      maxPromptTokens: 200,
      preserveRecentMessages: 2,
      estimator,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "old" }] },
      { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      { role: "user", content: [{ type: "text", text: "recent user msg" }] },
      { role: "assistant", content: [{ type: "text", text: "recent assistant msg" }] },
    ];

    const state = createMockState(prompt);
    await strategy.apply(state);

    // Tail messages should be the last 2 non-system messages
    const tailMessages = state.prompt.filter(m => m.role !== "system");
    expect(tailMessages).toHaveLength(2);

    const userMsg = tailMessages[0] as Extract<LanguageModelV3Message, { role: "user" }>;
    expect(userMsg.content[0]).toEqual({ type: "text", text: "recent user msg" });

    const assistantMsg = tailMessages[1] as Extract<LanguageModelV3Message, { role: "assistant" }>;
    expect(assistantMsg.content[0]).toEqual({ type: "text", text: "recent assistant msg" });
  });

  test("includes previous summary in next summarization pass", async () => {
    const { fn: summarize, calls } = makeSummarize();
    const strategy = new SummarizationStrategy({
      summarize,
      maxPromptTokens: 200,
      preserveRecentMessages: 1,
      estimator,
    });

    const previousSummary: LanguageModelV3Message = {
      role: "system",
      content: "previous summary text",
      providerOptions: { contextManagement: { type: "summary" } },
    };

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are helpful." },
      previousSummary,
      { role: "user", content: [{ type: "text", text: "msg 1" }] },
      { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
      { role: "user", content: [{ type: "text", text: "msg 2" }] },
    ];

    const state = createMockState(prompt);
    await strategy.apply(state);

    expect(calls).toHaveLength(1);
    // Should include the previous summary + 2 summarizable non-system messages
    expect(calls[0]).toHaveLength(3);
    expect(calls[0][0]).toEqual(previousSummary);

    // The old summary system message should be removed and replaced with the new one
    const summaryMessages = state.prompt.filter(
      (m) => m.role === "system" && m.providerOptions?.contextManagement
    );
    expect(summaryMessages).toHaveLength(1);
    expect(summaryMessages[0].content).toBe("summary of 3 messages");

    // The original system message should still be there
    const regularSystemMessages = state.prompt.filter(
      (m) => m.role === "system" && !m.providerOptions?.contextManagement
    );
    expect(regularSystemMessages).toHaveLength(1);
    expect(regularSystemMessages[0].content).toBe("You are helpful.");
  });

  test("reports removed tool exchanges", async () => {
    const { fn: summarize } = makeSummarize();
    const strategy = new SummarizationStrategy({
      summarize,
      maxPromptTokens: 200,
      preserveRecentMessages: 1,
      estimator,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { type: "text", value: "contents" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ];

    const state = createMockState(prompt);
    await strategy.apply(state);

    expect(state.capturedRemovedExchanges).toHaveLength(1);
    expect(state.capturedRemovedExchanges[0]).toEqual({
      toolCallId: "call-1",
      toolName: "read_file",
      reason: "summarization",
    });
  });

  test("pinned tool exchanges stay raw and out of the summary input", async () => {
    const { fn: summarize, calls } = makeSummarize();
    const strategy = new SummarizationStrategy({
      summarize,
      maxPromptTokens: 200,
      preserveRecentMessages: 1,
      estimator,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { type: "text", value: "contents" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "older question" }] },
      { role: "assistant", content: [{ type: "text", text: "older answer" }] },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ];

    const state = createMockState(prompt, ["call-1"]);
    await strategy.apply(state);

    expect(calls).toHaveLength(1);
    expect(calls[0].some((message) =>
      message.role !== "system" &&
      message.content.some((part) =>
        (part.type === "tool-call" || part.type === "tool-result") && part.toolCallId === "call-1"
      )
    )).toBe(false);
    expect(state.prompt.some((message) =>
      message.role !== "system" &&
      message.content.some((part) =>
        (part.type === "tool-call" || part.type === "tool-result") && part.toolCallId === "call-1"
      )
    )).toBe(true);
  });

  test("summary message is tagged with providerOptions", async () => {
    const { fn: summarize } = makeSummarize();
    const strategy = new SummarizationStrategy({
      summarize,
      maxPromptTokens: 200,
      preserveRecentMessages: 1,
      estimator,
    });

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "old" }] },
      { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ];

    const state = createMockState(prompt);
    await strategy.apply(state);

    const summaryMessage = state.prompt.find(
      (m) =>
        m.role === "system" &&
        m.providerOptions?.contextManagement &&
        (m.providerOptions.contextManagement as Record<string, unknown>).type === "summary"
    );

    expect(summaryMessage).toBeDefined();
    expect(summaryMessage!.role).toBe("system");
    expect(summaryMessage!.providerOptions).toEqual({
      contextManagement: { type: "summary" },
    });
  });
});
