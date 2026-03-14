import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { ToolResultDecayStrategy } from "../tool-result-decay-strategy.js";
import type { RemovedToolExchange } from "../types.js";

function makeToolPrompt(toolCount: number): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "initial request" }] },
  ];

  for (let i = 0; i < toolCount; i++) {
    const id = `call-${i}`;
    const name = `tool_${i}`;
    const output = `result-output-for-tool-${i}-${"x".repeat(200)}`;

    prompt.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: name, input: { query: `q${i}` } }],
    });
    prompt.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: id, toolName: name, output: { type: "text", value: output } }],
    });
  }

  prompt.push({ role: "user", content: [{ type: "text", text: "final question" }] });
  return prompt;
}

function createMockState(prompt: LanguageModelV3Prompt, pinnedIds: string[] = []) {
  const capturedRemoved: RemovedToolExchange[] = [];
  const pinnedSet = new Set(pinnedIds);

  const state = {
    params: { prompt, providerOptions: {} },
    prompt,
    requestContext: { conversationId: "conv-1", agentId: "agent-1" },
    removedToolExchanges: [] as readonly RemovedToolExchange[],
    pinnedToolCallIds: pinnedSet as ReadonlySet<string>,
    updatePrompt(newPrompt: LanguageModelV3Prompt) {
      state.prompt = newPrompt;
    },
    updateParams() {},
    addRemovedToolExchanges(exchanges: RemovedToolExchange[]) {
      capturedRemoved.push(...exchanges);
    },
    addPinnedToolCallIds(toolCallIds: string[]) {
      for (const id of toolCallIds) {
        pinnedSet.add(id);
      }
    },
  };

  return { state, capturedRemoved };
}

function getToolResultOutput(prompt: LanguageModelV3Prompt, toolCallId: string): string | undefined {
  for (const message of prompt) {
    if (message.role !== "tool" && message.role !== "assistant") {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) {
        if (part.output.type === "text") {
          return part.output.value;
        }
      }
    }
  }

  return undefined;
}

describe("ToolResultDecayStrategy", () => {
  test("does nothing when maxPromptTokens is not exceeded", () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy({
      maxPromptTokens: 10_000,
      estimator: {
        estimateMessage: () => 1,
        estimatePrompt: () => 100,
      },
    });
    const { state, capturedRemoved } = createMockState(prompt);
    const originalCall0 = getToolResultOutput(prompt, "call-0");

    strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe(originalCall0);
    expect(capturedRemoved).toEqual([]);
  });

  test("keeps recent tool results untouched (full zone)", () => {
    // 10 exchanges, keepFullResultCount=3 by default
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    strategy.apply(state);

    // The 3 most recent (call-7, call-8, call-9) should be untouched
    for (const id of ["call-7", "call-8", "call-9"]) {
      const output = getToolResultOutput(state.prompt, id);
      expect(output).toContain(`result-output-for-tool-${id.split("-")[1]}`);
      expect(output!.length).toBeGreaterThan(100);
    }
  });

  test("truncates medium-age tool results (truncate zone)", () => {
    // 10 exchanges, keepFull=3, truncateWindow=5 by default
    // Truncate zone: positions 3..7 from end = call-2..call-6
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    strategy.apply(state);

    // truncatedMaxTokens=200, so max chars = 200*4 = 800
    for (const id of ["call-2", "call-3", "call-4", "call-5", "call-6"]) {
      const output = getToolResultOutput(state.prompt, id);
      expect(output).toBeDefined();
      expect(output!.length).toBeLessThanOrEqual(800);
      // Should still have some content (not a placeholder)
      expect(output).not.toBe("[result omitted]");
    }
  });

  test("replaces old tool results with placeholder (placeholder zone)", () => {
    // 10 exchanges, keepFull=3, truncateWindow=5
    // Placeholder zone: positions >= 8 from end = call-0, call-1
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    strategy.apply(state);

    for (const id of ["call-0", "call-1"]) {
      const output = getToolResultOutput(state.prompt, id);
      expect(output).toBe("[result omitted]");
    }

    expect(capturedRemoved).toHaveLength(2);
    expect(capturedRemoved.map((e) => e.toolCallId).sort()).toEqual(["call-0", "call-1"]);
    expect(capturedRemoved[0].reason).toBe("tool-result-decay");
  });

  test("pinned tool results are never modified", () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy();
    // Pin call-0 (would normally be in placeholder zone) and call-3 (would be in truncate zone)
    const { state, capturedRemoved } = createMockState(prompt, ["call-0", "call-3"]);
    const originalCall0 = getToolResultOutput(prompt, "call-0");
    const originalCall3 = getToolResultOutput(prompt, "call-3");

    strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe(originalCall0);
    expect(getToolResultOutput(state.prompt, "call-3")).toBe(originalCall3);
    // call-0 is pinned so should not appear in removed
    expect(capturedRemoved.find((e) => e.toolCallId === "call-0")).toBeUndefined();
    expect(capturedRemoved.find((e) => e.toolCallId === "call-3")).toBeUndefined();
  });

  test("non-tool messages are never modified", () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    const originalSystem = (prompt[0] as any).content;
    const originalFirstUser = (prompt[1] as any).content[0].text;
    const originalLastUser = (prompt[prompt.length - 1] as any).content[0].text;

    strategy.apply(state);

    expect((state.prompt[0] as any).content).toBe(originalSystem);
    expect((state.prompt[1] as any).content[0].text).toBe(originalFirstUser);
    expect((state.prompt[state.prompt.length - 1] as any).content[0].text).toBe(originalLastUser);
  });

  test("preserves tool-call parts untouched", () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    strategy.apply(state);

    // All assistant messages with tool-call parts should still have their input
    const toolCalls = state.prompt
      .filter((m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((p) => p.type === "tool-call");

    expect(toolCalls).toHaveLength(10);
    for (const call of toolCalls) {
      if (call.type === "tool-call") {
        expect(call.input).toBeDefined();
      }
    }
  });

  test("custom placeholder string", () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy({ placeholder: "<removed>" });
    const { state } = createMockState(prompt);

    strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe("<removed>");
  });

  test("custom placeholder function receives toolName and toolCallId", () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy({
      placeholder: (toolName, toolCallId) => `[${toolName}:${toolCallId} omitted]`,
    });
    const { state } = createMockState(prompt);

    strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[tool_0:call-0 omitted]");
    expect(getToolResultOutput(state.prompt, "call-1")).toBe("[tool_1:call-1 omitted]");
  });

  test("custom keepFullResultCount and truncateWindowCount", () => {
    const prompt = makeToolPrompt(6);
    const strategy = new ToolResultDecayStrategy({
      keepFullResultCount: 1,
      truncateWindowCount: 2,
    });
    const { state, capturedRemoved } = createMockState(prompt);

    strategy.apply(state);

    // Full zone: call-5 (most recent)
    const fullOutput = getToolResultOutput(state.prompt, "call-5");
    expect(fullOutput!.length).toBeGreaterThan(100);

    // Truncate zone: call-3, call-4
    for (const id of ["call-3", "call-4"]) {
      const output = getToolResultOutput(state.prompt, id);
      expect(output).not.toBe("[result omitted]");
      expect(output!.length).toBeLessThanOrEqual(800);
    }

    // Placeholder zone: call-0, call-1, call-2
    for (const id of ["call-0", "call-1", "call-2"]) {
      expect(getToolResultOutput(state.prompt, id)).toBe("[result omitted]");
    }

    expect(capturedRemoved).toHaveLength(3);
  });

  test("truncation respects truncatedMaxTokens option", () => {
    const prompt = makeToolPrompt(5);
    const strategy = new ToolResultDecayStrategy({
      keepFullResultCount: 1,
      truncateWindowCount: 3,
      truncatedMaxTokens: 10, // 10 tokens * 4 chars = 40 chars max
    });
    const { state } = createMockState(prompt);

    strategy.apply(state);

    for (const id of ["call-1", "call-2", "call-3"]) {
      const output = getToolResultOutput(state.prompt, id);
      expect(output!.length).toBeLessThanOrEqual(40);
    }
  });

  test("does nothing when there are no tool exchanges", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const strategy = new ToolResultDecayStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    strategy.apply(state);

    expect(capturedRemoved).toHaveLength(0);
    expect(state.prompt).toHaveLength(3);
  });

  test("does nothing when all exchanges fit in the full zone", () => {
    const prompt = makeToolPrompt(2); // 2 exchanges, keepFull=3
    const strategy = new ToolResultDecayStrategy();
    const { state, capturedRemoved } = createMockState(prompt);
    const originalOutputs = ["call-0", "call-1"].map((id) => getToolResultOutput(prompt, id));

    strategy.apply(state);

    expect(capturedRemoved).toHaveLength(0);
    expect(getToolResultOutput(state.prompt, "call-0")).toBe(originalOutputs[0]);
    expect(getToolResultOutput(state.prompt, "call-1")).toBe(originalOutputs[1]);
  });

  test("does not mutate the original prompt", () => {
    const prompt = makeToolPrompt(10);
    const originalCall0Output = getToolResultOutput(prompt, "call-0");
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    strategy.apply(state);

    // Original prompt should be untouched
    expect(getToolResultOutput(prompt, "call-0")).toBe(originalCall0Output);
    // Modified prompt should have placeholder
    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[result omitted]");
  });

  test("strategy has the correct name", () => {
    const strategy = new ToolResultDecayStrategy();
    expect(strategy.name).toBe("tool-result-decay");
  });

  test("short outputs in truncate zone are left as-is", () => {
    // Create a prompt with short tool outputs
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];

    for (let i = 0; i < 5; i++) {
      const id = `call-${i}`;
      prompt.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: `tool_${i}`, input: {} }],
      });
      prompt.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: id, toolName: `tool_${i}`, output: { type: "text", value: "short" } }],
      });
    }

    const strategy = new ToolResultDecayStrategy({
      keepFullResultCount: 1,
      truncateWindowCount: 3,
    });
    const { state } = createMockState(prompt);

    strategy.apply(state);

    // "short" is 5 chars, well under the 800 char limit, so should be unchanged
    for (const id of ["call-1", "call-2", "call-3"]) {
      expect(getToolResultOutput(state.prompt, id)).toBe("short");
    }
  });
});
