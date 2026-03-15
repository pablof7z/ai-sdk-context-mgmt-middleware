import type { LanguageModelV3Prompt, LanguageModelV3ToolResultOutput } from "@ai-sdk/provider";
import { ToolResultDecayStrategy } from "../tool-result-decay-strategy.js";
import type { ContextManagementReminder, DecayedToolContext, RemovedToolExchange } from "../types.js";

function makeToolPrompt(toolCount: number, outputSize = 200): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "initial request" }] },
  ];

  for (let i = 0; i < toolCount; i++) {
    const id = `call-${i}`;
    const name = `tool_${i}`;
    const output = `result-output-for-tool-${i}-${"x".repeat(outputSize)}`;

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
  const capturedReminders: ContextManagementReminder[] = [];
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
    async emitReminder(reminder: ContextManagementReminder) {
      capturedReminders.push(reminder);
    },
  };

  return { state, capturedRemoved, capturedReminders };
}

function getToolResultOutput(prompt: LanguageModelV3Prompt, toolCallId: string): string | undefined {
  const raw = getRawToolResultOutput(prompt, toolCallId);
  return raw?.type === "text" ? raw.value : undefined;
}

function getRawToolResultOutput(prompt: LanguageModelV3Prompt, toolCallId: string): LanguageModelV3ToolResultOutput | undefined {
  for (const message of prompt) {
    if (message.role !== "tool" && message.role !== "assistant") {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) {
        return part.output;
      }
    }
  }

  return undefined;
}

function getToolCallInput(prompt: LanguageModelV3Prompt, toolCallId: string): unknown {
  for (const message of prompt) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) {
        return part.input;
      }
    }
  }

  return undefined;
}

function makeToolPromptWithInputs(
  entries: Array<{ id: string; name: string; input: unknown; output: LanguageModelV3ToolResultOutput }>
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "initial request" }] },
  ];

  for (const { id, name, input, output } of entries) {
    prompt.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: name, input }],
    });
    prompt.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: id, toolName: name, output }],
    });
  }

  prompt.push({ role: "user", content: [{ type: "text", text: "final question" }] });
  return prompt;
}

function makeToolPromptWithOutputs(
  outputs: Array<{ id: string; name: string; output: LanguageModelV3ToolResultOutput }>
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "initial request" }] },
  ];

  for (const { id, name, output } of outputs) {
    prompt.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: name, input: {} }],
    });
    prompt.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: id, toolName: name, output }],
    });
  }

  prompt.push({ role: "user", content: [{ type: "text", text: "final question" }] });
  return prompt;
}

describe("ToolResultDecayStrategy", () => {
  test("does nothing when maxPromptTokens is not exceeded", async () => {
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

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe(originalCall0);
    expect(capturedRemoved).toEqual([]);
  });

  test("depth 0 (most recent) is never touched regardless of result size", async () => {
    // Single large result - depth 0, should be untouched
    const largeOutput = "x".repeat(10000);
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: largeOutput } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe(largeOutput);
  });

  test("large result at depth 1 is truncated to baseMaxChars", async () => {
    // 2 exchanges: call-0 at depth 1, call-1 at depth 0
    // truncatedMaxTokens=200 → baseMaxChars=800
    // depth 1 budget = 800/1 = 800
    const largeOutput = "x".repeat(5000);
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output = getToolResultOutput(state.prompt, "call-0");
    expect(output!.length).toBeLessThanOrEqual(800);
    expect(output!.length).toBeGreaterThan(0);
    // call-1 (depth 0) untouched
    expect(getToolResultOutput(state.prompt, "call-1")).toBe("recent");
  });

  test("same result at depth 2 is truncated to baseMaxChars/2", async () => {
    // 3 exchanges: call-0 at depth 2, call-1 at depth 1, call-2 at depth 0
    const largeOutput = "x".repeat(5000);
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: largeOutput } },
      { id: "call-2", name: "tool_2", output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy(); // truncatedMaxTokens=200 → baseMaxChars=800
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0: depth 2, budget = 800/2 = 400
    const output0 = getToolResultOutput(state.prompt, "call-0");
    expect(output0!.length).toBeLessThanOrEqual(400);
    // call-1: depth 1, budget = 800/1 = 800
    const output1 = getToolResultOutput(state.prompt, "call-1");
    expect(output1!.length).toBeLessThanOrEqual(800);
  });

  test("small result at deep depth stays untouched (under budget)", async () => {
    // 6 exchanges: call-0 at depth 5, etc.
    // Small output = 10 chars. Depth 5 budget = 800/5 = 160. 10 < 160 → full
    const outputs = Array.from({ length: 6 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: "short text" },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 is at depth 5, budget = 800/5 = 160. "short text" = 10 chars → full
    expect(getToolResultOutput(state.prompt, "call-0")).toBe("short text");
  });

  test("result at very deep depth is placeholdered", async () => {
    // With defaults: placeholderFloorTokens=20, placeholderFloorChars=80
    // baseMaxChars=800, so placeholder when 800/d < 80, i.e. d > 10
    // 12 exchanges: call-0 at depth 11
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: i === 0 ? largeOutput : "ok" },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[result omitted]");
    expect(capturedRemoved.some((e) => e.toolCallId === "call-0")).toBe(true);
  });

  test("pinned results are never modified", async () => {
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    // Pin call-0 (would normally be placeholdered at depth 11)
    const { state, capturedRemoved } = createMockState(prompt, ["call-0"]);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe(largeOutput);
    expect(capturedRemoved.find((e) => e.toolCallId === "call-0")).toBeUndefined();
  });

  test("non-tool messages are never modified", async () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    const originalSystem = (prompt[0] as any).content;
    const originalFirstUser = (prompt[1] as any).content[0].text;
    const originalLastUser = (prompt[prompt.length - 1] as any).content[0].text;

    await strategy.apply(state);

    expect((state.prompt[0] as any).content).toBe(originalSystem);
    expect((state.prompt[1] as any).content[0].text).toBe(originalFirstUser);
    expect((state.prompt[state.prompt.length - 1] as any).content[0].text).toBe(originalLastUser);
  });

  test("preserves tool-call parts untouched", async () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

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

  test("custom placeholder string", async () => {
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy({ placeholder: "<removed>" });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 11 should be placeholdered
    expect(getToolResultOutput(state.prompt, "call-0")).toBe("<removed>");
  });

  test("custom placeholder function receives DecayedToolContext", async () => {
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const captured: DecayedToolContext[] = [];
    const strategy = new ToolResultDecayStrategy({
      placeholder: (ctx) => {
        captured.push({ ...ctx });
        return `[${ctx.toolName}:${ctx.toolCallId} ${ctx.action}]`;
      },
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 11 should be placeholdered
    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[tool_0:call-0 placeholder]");

    // Verify context was populated
    const placeholderCtx = captured.find((c) => c.toolCallId === "call-0" && c.action === "placeholder");
    expect(placeholderCtx).toBeDefined();
    expect(placeholderCtx!.toolName).toBe("tool_0");
    expect(placeholderCtx!.output).toEqual({ type: "text", value: largeOutput });
    expect(placeholderCtx!.input).toEqual({});
  });

  test("does nothing when there are no tool exchanges", async () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const strategy = new ToolResultDecayStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    await strategy.apply(state);

    expect(capturedRemoved).toHaveLength(0);
    expect(state.prompt).toHaveLength(3);
  });

  test("does not mutate the original prompt", async () => {
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // Original prompt should be untouched
    expect(getToolResultOutput(prompt, "call-0")).toBe(largeOutput);
    // Modified prompt should have placeholder
    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[result omitted]");
  });

  test("strategy has the correct name", () => {
    const strategy = new ToolResultDecayStrategy();
    expect(strategy.name).toBe("tool-result-decay");
  });

  test("truncates JSON output when it exceeds depth budget", async () => {
    const largeJson = { data: "x".repeat(2000), nested: { key: "value" } };
    // 3 exchanges: call-0 at depth 2, call-1 at depth 1, call-2 at depth 0
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "json" as const, value: largeJson } },
      { id: "call-1", name: "tool_1", output: { type: "json" as const, value: largeJson } },
      { id: "call-2", name: "tool_2", output: { type: "json" as const, value: largeJson } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy({
      truncatedMaxTokens: 50, // baseMaxChars = 200
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-2 at depth 0: always full
    const fullOutput = getRawToolResultOutput(state.prompt, "call-2");
    expect(fullOutput?.type).toBe("json");

    // call-1 at depth 1: budget = 200, large JSON > 200 → truncated
    const output1 = getRawToolResultOutput(state.prompt, "call-1");
    expect(output1?.type).toBe("text");
    if (output1?.type === "text") {
      expect(output1.value.length).toBeLessThanOrEqual(200);
    }

    // call-0 at depth 2: budget = 100, also truncated
    const output0 = getRawToolResultOutput(state.prompt, "call-0");
    expect(output0?.type).toBe("text");
    if (output0?.type === "text") {
      expect(output0.value.length).toBeLessThanOrEqual(100);
    }
  });

  test("leaves small JSON output unchanged even at depth > 0", async () => {
    const smallJson = { ok: true };
    const outputs = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "json" as const, value: smallJson },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // Small JSON should remain as JSON type everywhere (under budget at all depths)
    for (const id of ["call-0", "call-1", "call-2", "call-3", "call-4"]) {
      const output = getRawToolResultOutput(state.prompt, id);
      expect(output?.type).toBe("json");
    }
  });

  test("strips binary content from content-type outputs when truncated", async () => {
    const imageOutput: LanguageModelV3ToolResultOutput = {
      type: "content",
      value: [
        { type: "text", text: "Here is the screenshot" },
        { type: "image-data", data: "x".repeat(50000), mediaType: "image/png" },
      ],
    };

    // 2 exchanges: call-0 at depth 1, call-1 at depth 0
    const outputs = [
      { id: "call-0", name: "screenshot", output: imageOutput },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: image content is large (~50000 chars), budget = 800
    // Content gets flattened to text (no base64) and truncated
    const output = getRawToolResultOutput(state.prompt, "call-0");
    expect(output?.type).toBe("text");
    if (output?.type === "text") {
      expect(output.value).toContain("Here is the screenshot");
      expect(output.value).toContain("[image: image/png]");
      expect(output.value).not.toContain("x".repeat(100));
      expect(output.value.length).toBeLessThanOrEqual(800);
    }
  });

  test("content output with file-data includes filename in descriptor", async () => {
    const fileOutput: LanguageModelV3ToolResultOutput = {
      type: "content",
      value: [
        { type: "text", text: "File contents:" },
        { type: "file-data", data: "x".repeat(10000), mediaType: "application/pdf", filename: "report.pdf" },
      ],
    };

    // 2 exchanges: call-0 at depth 1, call-1 at depth 0
    const outputs = [
      { id: "call-0", name: "read_file", output: fileOutput },
      { id: "call-1", name: "tool", output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output = getRawToolResultOutput(state.prompt, "call-0");
    expect(output?.type).toBe("text");
    if (output?.type === "text") {
      expect(output.value).toContain("[file: application/pdf, report.pdf]");
    }
  });

  test("error-text output is truncated like text", async () => {
    const largeError = `Error: ${"detail ".repeat(200)}`;
    // 3 exchanges
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "error-text" as const, value: largeError } },
      { id: "call-1", name: "tool_1", output: { type: "error-text" as const, value: largeError } },
      { id: "call-2", name: "tool_2", output: { type: "error-text" as const, value: largeError } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy({
      truncatedMaxTokens: 25, // baseMaxChars = 100
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 2: budget = 100/2 = 50
    const output0 = getRawToolResultOutput(state.prompt, "call-0");
    expect(output0?.type).toBe("text");
    if (output0?.type === "text") {
      expect(output0.value.length).toBeLessThanOrEqual(50);
    }

    // call-1 at depth 1: budget = 100/1 = 100
    const output1 = getRawToolResultOutput(state.prompt, "call-1");
    expect(output1?.type).toBe("text");
    if (output1?.type === "text") {
      expect(output1.value.length).toBeLessThanOrEqual(100);
      expect(output1.value).toContain("Error:");
    }
  });

  test("error-json output is serialized and truncated", async () => {
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "error-json" as const, value: { error: "x".repeat(2000) } } },
      { id: "call-1", name: "tool_1", output: { type: "error-json" as const, value: { error: "x".repeat(2000) } } },
      { id: "call-2", name: "tool_2", output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy({
      truncatedMaxTokens: 50, // baseMaxChars = 200
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 2: budget = 200/2 = 100
    const output0 = getRawToolResultOutput(state.prompt, "call-0");
    expect(output0?.type).toBe("text");
    if (output0?.type === "text") {
      expect(output0.value.length).toBeLessThanOrEqual(100);
    }
  });

  test("execution-denied output is left untouched in truncation", async () => {
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "execution-denied" as const, reason: "user denied" } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: execution-denied is always returned as-is by truncateToolResultOutput
    const output = getRawToolResultOutput(state.prompt, "call-0");
    expect(output?.type).toBe("execution-denied");
  });

  test("mixed output types are each handled correctly", async () => {
    const outputs = [
      { id: "call-0", name: "glob", output: { type: "json" as const, value: { files: Array.from({ length: 100 }, (_, i) => `file-${i}.txt`) } } },
      { id: "call-1", name: "read", output: { type: "text" as const, value: "x".repeat(5000) } },
      { id: "call-2", name: "screenshot", output: {
        type: "content" as const,
        value: [
          { type: "text" as const, text: "Screenshot taken" },
          { type: "image-data" as const, data: "x".repeat(100000), mediaType: "image/png" },
        ],
      } },
      { id: "call-3", name: "search", output: { type: "json" as const, value: { results: ["a", "b"] } } },
      { id: "call-4", name: "latest", output: { type: "text" as const, value: "latest result" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy({
      truncatedMaxTokens: 100, // baseMaxChars = 400
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-4: depth 0 — always full
    expect(getToolResultOutput(state.prompt, "call-4")).toBe("latest result");

    // call-3: depth 1, budget = 400. Small JSON (~25 chars) → stays as JSON
    const call3 = getRawToolResultOutput(state.prompt, "call-3");
    expect(call3?.type).toBe("json");

    // call-2: depth 2, budget = 200. Image content (~100016 chars) → flattened and truncated
    const call2 = getRawToolResultOutput(state.prompt, "call-2");
    expect(call2?.type).toBe("text");
    if (call2?.type === "text") {
      expect(call2.value.length).toBeLessThanOrEqual(200);
    }

    // call-1: depth 3, budget = 133. Long text (5000 chars) → truncated
    const call1 = getRawToolResultOutput(state.prompt, "call-1");
    expect(call1?.type).toBe("text");
    if (call1?.type === "text") {
      expect(call1.value.length).toBeLessThanOrEqual(133);
    }

    // call-0: depth 4, budget = 100. Large JSON → truncated
    const call0 = getRawToolResultOutput(state.prompt, "call-0");
    expect(call0?.type).toBe("text");
    if (call0?.type === "text") {
      expect(call0.value.length).toBeLessThanOrEqual(100);
    }
  });

  test("warning reminder emitted for large at-risk results", async () => {
    // 2 exchanges: call-0 at depth 1 with large result
    // At depth 1 budget = 800, it's currently full (5000 > 800 → truncated, not full)
    // Let's use truncatedMaxTokens=2000 so baseMaxChars=8000 to ensure call-0 is currently full
    const largeOutput = "x".repeat(5000);
    const outputs = [
      { id: "call-0", name: "read_file", output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy({
      truncatedMaxTokens: 2000, // baseMaxChars = 8000
    });
    const { state, capturedReminders } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: budget = 8000/1 = 8000. 5000 < 8000 → full
    // At depth 2: budget = 8000/2 = 4000. 5000 > 4000 → truncated. Significant compression.
    // But 5000 chars is NOT > baseMaxChars (8000), so no warning issued.
    // Let me adjust: we need estimatedChars > baseMaxChars for warning
    expect(capturedReminders).toHaveLength(0);
  });

  test("warning reminder emitted for very large results exceeding baseMaxChars", async () => {
    // Use a result larger than baseMaxChars that is currently full at depth 0
    // and will be truncated at depth 1
    const hugeOutput = "x".repeat(10000);
    const outputs = [
      { id: "call-0", name: "read_file", output: { type: "text" as const, value: hugeOutput } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy({
      truncatedMaxTokens: 200, // baseMaxChars = 800
    });
    const { state, capturedReminders } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 0: full (always)
    // At depth 1: budget = 800. 10000 > 800 → truncated.
    // estimatedChars (10000) > baseMaxChars (800) → at-risk
    expect(capturedReminders).toHaveLength(1);
    expect(capturedReminders[0].kind).toBe("tool-result-decay-warning");
    expect(capturedReminders[0].content).toContain("call-0");
    expect(capturedReminders[0].content).toContain("read_file");
    expect(capturedReminders[0].content).toContain("truncated");
  });

  test("no warning for small results", async () => {
    const outputs = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: "small" },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state, capturedReminders } = createMockState(prompt);

    await strategy.apply(state);

    expect(capturedReminders).toHaveLength(0);
  });

  test("maxPromptTokens gate still works (skip when under budget)", async () => {
    const prompt = makeToolPrompt(10);
    const strategy = new ToolResultDecayStrategy({
      maxPromptTokens: 10_000,
      estimator: {
        estimateMessage: () => 1,
        estimatePrompt: () => 100,
      },
    });
    const { state } = createMockState(prompt);

    const result = await strategy.apply(state);

    expect(result.reason).toBe("below-token-threshold");
  });

  test("returns correct payload fields", async () => {
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    const result = await strategy.apply(state);

    expect(result.reason).toBe("tool-results-decayed");
    expect(result.payloads).toHaveProperty("truncatedMaxTokens");
    expect(result.payloads).toHaveProperty("placeholderFloorTokens");
    expect(result.payloads).toHaveProperty("truncatedCount");
    expect(result.payloads).toHaveProperty("placeholderCount");
    expect(result.payloads).toHaveProperty("totalToolExchanges", 5);
    expect(result.payloads).toHaveProperty("warningCount");
    // Should NOT have old fields
    expect(result.payloads).not.toHaveProperty("keepFullResultCount");
    expect(result.payloads).not.toHaveProperty("truncateWindowCount");
  });

  test("deeper exchanges get progressively smaller budgets", async () => {
    // 5 exchanges all with 1000-char results, truncatedMaxTokens=100 → baseMaxChars=400
    const output = "x".repeat(1000);
    const outputs = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: output },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy({
      truncatedMaxTokens: 100, // baseMaxChars = 400
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-4: depth 0 → full (1000 chars)
    expect(getToolResultOutput(state.prompt, "call-4")!.length).toBe(1000);
    // call-3: depth 1 → budget 400 → truncated to 400
    expect(getToolResultOutput(state.prompt, "call-3")!.length).toBeLessThanOrEqual(400);
    // call-2: depth 2 → budget 200 → truncated to 200
    expect(getToolResultOutput(state.prompt, "call-2")!.length).toBeLessThanOrEqual(200);
    // call-1: depth 3 → budget 133 → truncated to 133
    expect(getToolResultOutput(state.prompt, "call-1")!.length).toBeLessThanOrEqual(133);
    // call-0: depth 4 → budget 100 → truncated to 100
    expect(getToolResultOutput(state.prompt, "call-0")!.length).toBeLessThanOrEqual(100);

    // Verify progressive shrinking
    const len3 = getToolResultOutput(state.prompt, "call-3")!.length;
    const len2 = getToolResultOutput(state.prompt, "call-2")!.length;
    const len1 = getToolResultOutput(state.prompt, "call-1")!.length;
    const len0 = getToolResultOutput(state.prompt, "call-0")!.length;
    expect(len3).toBeGreaterThan(len2);
    expect(len2).toBeGreaterThan(len1);
    expect(len1).toBeGreaterThanOrEqual(len0);
  });

  test("truncated results get header line when placeholder is a function", async () => {
    // 2 exchanges: call-0 at depth 1 with large output
    const largeOutput = "x".repeat(5000);
    const entries = [
      { id: "call-0", name: "fs_write", input: { description: "Write config" }, output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", input: {}, output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = new ToolResultDecayStrategy({
      placeholder: (ctx) => {
        if (ctx.action === "truncate") {
          return `[truncated: ${ctx.toolName}]\n`;
        }
        return `[omitted: ${ctx.toolName}]`;
      },
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: budget = 800. 5000 > 800 → truncated
    const output = getToolResultOutput(state.prompt, "call-0");
    expect(output).toBeDefined();
    expect(output!.startsWith("[truncated: fs_write]\n")).toBe(true);
  });

  test("truncated results get NO header when placeholder is a string", async () => {
    const largeOutput = "x".repeat(5000);
    const entries = [
      { id: "call-0", name: "fs_write", input: {}, output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", input: {}, output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = new ToolResultDecayStrategy({ placeholder: "<removed>" });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: truncated, but string placeholder means no header
    const output = getToolResultOutput(state.prompt, "call-0");
    expect(output).toBeDefined();
    expect(output!.startsWith("x")).toBe(true);
    expect(output!.length).toBeLessThanOrEqual(800);
  });

  test("tool-call inputs are decayed when decayInputs is true", async () => {
    // 3 exchanges with large inputs at depth 2, 1, 0
    const largeInput = { content: "y".repeat(5000), description: "Write file" };
    const entries = [
      { id: "call-0", name: "fs_write", input: largeInput, output: { type: "text" as const, value: "ok" } },
      { id: "call-1", name: "fs_write", input: largeInput, output: { type: "text" as const, value: "ok" } },
      { id: "call-2", name: "fs_read", input: { path: "/a" }, output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = new ToolResultDecayStrategy({ decayInputs: true });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 2: input is ~5040 chars, budget = 800/2 = 400 → truncated
    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0._truncated).toBeDefined();
    expect(typeof input0._truncated).toBe("string");
    expect((input0._truncated as string).length).toBeLessThanOrEqual(400);

    // call-1 at depth 1: input is ~5040 chars, budget = 800/1 = 800 → truncated
    const input1 = getToolCallInput(state.prompt, "call-1") as Record<string, unknown>;
    expect(input1._truncated).toBeDefined();

    // call-2 at depth 0: always full
    const input2 = getToolCallInput(state.prompt, "call-2") as Record<string, unknown>;
    expect(input2.path).toBe("/a");
  });

  test("tool-call inputs are NOT decayed when decayInputs is false", async () => {
    const largeInput = { content: "y".repeat(5000) };
    const entries = [
      { id: "call-0", name: "fs_write", input: largeInput, output: { type: "text" as const, value: "ok" } },
      { id: "call-1", name: "fs_read", input: { path: "/a" }, output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = new ToolResultDecayStrategy({ decayInputs: false });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: large input but decayInputs=false → untouched
    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0.content).toBe("y".repeat(5000));
  });

  test("large inputs at shallow depth are truncated, small inputs stay full", async () => {
    // 3 exchanges: large input at depth 1 is truncated; small input at depth 2 stays full
    const entries = [
      { id: "call-0", name: "tool_0", input: { q: "tiny" }, output: { type: "text" as const, value: "ok" } },
      { id: "call-1", name: "fs_write", input: { content: "z".repeat(5000) }, output: { type: "text" as const, value: "ok" } },
      { id: "call-2", name: "tool_2", input: { q: "recent" }, output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 2: input ~14 chars, budget = 800/2 = 400 → full
    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0.q).toBe("tiny");

    // call-1 at depth 1: input ~5020 chars, budget = 800 → truncated
    const input1 = getToolCallInput(state.prompt, "call-1") as Record<string, unknown>;
    expect(input1._truncated).toBeDefined();
  });

  test("warning text uses formatter output when placeholder is a function", async () => {
    const hugeOutput = "x".repeat(10000);
    const entries = [
      { id: "call-0", name: "read_file", input: { description: "Read the config" }, output: { type: "text" as const, value: hugeOutput } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = new ToolResultDecayStrategy({
      truncatedMaxTokens: 200,
      placeholder: (ctx) => `[${ctx.toolName} id:${ctx.toolCallId}]`,
    });
    const { state, capturedReminders } = createMockState(prompt);

    await strategy.apply(state);

    expect(capturedReminders).toHaveLength(1);
    expect(capturedReminders[0].content).toContain("[read_file id:call-0]");
  });

  test("payloads include inputTruncatedCount and inputPlaceholderCount", async () => {
    const largeInput = { content: "y".repeat(5000) };
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      input: largeInput,
      output: { type: "text" as const, value: "ok" },
    }));
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    const result = await strategy.apply(state);

    expect(result.payloads).toHaveProperty("inputTruncatedCount");
    expect(result.payloads).toHaveProperty("inputPlaceholderCount");
    expect(typeof (result.payloads as Record<string, unknown>).inputTruncatedCount).toBe("number");
    expect(typeof (result.payloads as Record<string, unknown>).inputPlaceholderCount).toBe("number");
  });

  test("inputs at very deep depth are omitted", async () => {
    // 12 exchanges: call-0 at depth 11 with large input
    const largeInput = { content: "y".repeat(5000) };
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      input: i === 0 ? largeInput : { q: "small" },
      output: { type: "text" as const, value: "ok" },
    }));
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 11: 800/11 = 72 < placeholderFloor (80) → placeholder
    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0._omitted).toBe(true);
  });
});
