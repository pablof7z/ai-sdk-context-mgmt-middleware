import { SlidingWindowStrategy } from "../index.js";
import { createContextManagementRuntime } from "../runtime.js";
import { makePrompt } from "./helpers.js";

describe("SlidingWindowStrategy", () => {
  test("preserves system messages and trims oldest non-system messages", async () => {
    const runtime = createContextManagementRuntime({
      strategies: [new SlidingWindowStrategy({ keepLastMessages: 2 })],
    });

    const result = await runtime.middleware.transformParams?.({
      params: {
        prompt: makePrompt(),
        providerOptions: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
          },
        },
      },
      model: { specificationVersion: "v3", provider: "mock", modelId: "mock", doGenerate: async () => { throw new Error("unused"); }, doStream: async () => { throw new Error("unused"); }, supportedUrls: {} },
    } as any);

    expect(result?.prompt.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "user",
    ]);
  });

  test("does not split tool-call and tool-result pairs at the trim boundary", async () => {
    const strategy = new SlidingWindowStrategy({ keepLastMessages: 2 });
    const captured: any[] = [];
    const state = {
      prompt: makePrompt(),
      removedToolExchanges: [],
      params: { prompt: makePrompt(), providerOptions: {} },
      requestContext: { conversationId: "conv-1", agentId: "agent-1" },
      pinnedToolCallIds: new Set<string>(),
      updatePrompt(prompt: any) {
        this.prompt = prompt;
      },
      updateParams() {},
      addRemovedToolExchanges(exchanges: any[]) {
        captured.push(...exchanges);
      },
      addPinnedToolCallIds() {},
    };

    strategy.apply(state as any);

    expect(state.prompt.some((message: any) => message.role === "assistant" && message.content.some((part: any) => part.type === "tool-call" && part.toolCallId === "call-old"))).toBe(true);
    expect(state.prompt.some((message: any) => message.role === "tool" && message.content.some((part: any) => part.type === "tool-result" && part.toolCallId === "call-old"))).toBe(true);
    expect(captured).toEqual([]);
  });

  test("can keep shrinking until an estimated token budget is met", async () => {
    const runtime = createContextManagementRuntime({
      strategies: [
        new SlidingWindowStrategy({
          keepLastMessages: 4,
          maxPromptTokens: 20,
          estimator: {
            estimateMessage: () => 10,
            estimatePrompt: (prompt) => prompt.length * 10,
          },
        }),
      ],
    });

    const result = await runtime.middleware.transformParams?.({
      params: {
        prompt: makePrompt(),
        providerOptions: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
          },
        },
      },
      model: { specificationVersion: "v3", provider: "mock", modelId: "mock", doGenerate: async () => { throw new Error("unused"); }, doStream: async () => { throw new Error("unused"); }, supportedUrls: {} },
    } as any);

    const nonSystemCount = result?.prompt.filter((message) => message.role !== "system").length;
    expect(nonSystemCount).toBe(1);
  });

  test("supports preserving a head segment via headCount", () => {
    const prompt = makePrompt();
    const strategy = new SlidingWindowStrategy({ headCount: 1, keepLastMessages: 2 });
    const state = {
      prompt,
      removedToolExchanges: [],
      params: { prompt, providerOptions: {} },
      requestContext: { conversationId: "conv-1", agentId: "agent-1" },
      pinnedToolCallIds: new Set<string>(),
      updatePrompt(nextPrompt: any) {
        this.prompt = nextPrompt;
      },
      updateParams() {},
      addRemovedToolExchanges() {},
      addPinnedToolCallIds() {},
    };

    strategy.apply(state as any);

    expect(state.prompt.map((message: any) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
  });
});
