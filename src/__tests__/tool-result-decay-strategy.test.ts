import type { LanguageModelV3Prompt, LanguageModelV3ToolResultOutput } from "@ai-sdk/provider";
import { ToolResultDecayStrategy } from "../index.js";
import type {
  ContextManagementReminder,
  DecayedToolContext,
  RemovedToolExchange,
  ToolResultDecayStrategyOptions,
} from "../types.js";

const DEPTH_ONLY_PRESSURE_ANCHORS = [
  { toolTokens: 1, depthFactor: 1 },
  { toolTokens: 5_000, depthFactor: 1 },
  { toolTokens: 50_000, depthFactor: 1 },
];

function createDepthOnlyStrategy(options: ToolResultDecayStrategyOptions = {}) {
  return new ToolResultDecayStrategy({
    ...options,
    pressureAnchors: DEPTH_ONLY_PRESSURE_ANCHORS,
  });
}

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

function makeToolPromptWithBatchCalls(
  batches: Array<Array<{ id: string; name: string; output: LanguageModelV3ToolResultOutput }>>
): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "initial request" }] },
  ];

  for (const batch of batches) {
    // All tool calls in one assistant message (same turn/batch, same callMessageIndex)
    prompt.push({
      role: "assistant",
      content: batch.map(({ id, name }) => ({
        type: "tool-call",
        toolCallId: id,
        toolName: name,
        input: {},
      })),
    });
    // Each tool result in its own message
    for (const { id, name, output } of batch) {
      prompt.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: id, toolName: name, output }],
      });
    }
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
  test("still applies decay when the total prompt estimate is low", async () => {
    const prompt = makeToolPromptWithOutputs([
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: "x".repeat(5000) } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "recent" } },
    ]);
    const strategy = createDepthOnlyStrategy({
      estimator: {
        estimateMessage: () => 1,
        estimatePrompt: () => 100,
      },
    });
    const { state, capturedRemoved } = createMockState(prompt);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[result omitted]");
    expect(capturedRemoved).toEqual([
      {
        reason: "tool-result-decay",
        toolCallId: "call-0",
        toolName: "tool_0",
      },
    ]);
  });

  test("depth 0 (most recent) is never touched regardless of result size", async () => {
    // Single large result - depth 0, should be untouched
    const largeOutput = "x".repeat(10000);
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: largeOutput } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe(largeOutput);
  });

  test("large result at depth 1 becomes a placeholder", async () => {
    // 2 exchanges: call-0 at depth 1, call-1 at depth 0
    // maxResultTokens=200 → baseMaxChars=800
    // depth 1 budget = 800/1 = 800
    const largeOutput = "x".repeat(5000);
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output = getToolResultOutput(state.prompt, "call-0");
    expect(output).toBe("[result omitted]");
    // call-1 (depth 0) untouched
    expect(getToolResultOutput(state.prompt, "call-1")).toBe("recent");
  });

  test("same large result at deeper depths still becomes a placeholder", async () => {
    // 3 exchanges: call-0 at depth 2, call-1 at depth 1, call-2 at depth 0
    const largeOutput = "x".repeat(5000);
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: largeOutput } },
      { id: "call-2", name: "tool_2", output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy(); // maxResultTokens=200 → baseMaxChars=800
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[result omitted]");
    expect(getToolResultOutput(state.prompt, "call-1")).toBe("[result omitted]");
    expect(getToolResultOutput(state.prompt, "call-2")).toBe("recent");
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
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 is at depth 5, budget = 800/5 = 160. "short text" = 10 chars → full
    expect(getToolResultOutput(state.prompt, "call-0")).toBe("short text");
  });

  test("result at very deep depth is placeholdered", async () => {
    // With defaults: placeholderMinSourceTokens=800, placeholderMinSourceChars=3200.
    // baseMaxChars=800, so a 5000-char result is over budget and above the placeholder minimum.
    // 12 exchanges: call-0 at depth 11
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: i === 0 ? largeOutput : "ok" },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[result omitted]");
    expect(capturedRemoved.some((e) => e.toolCallId === "call-0")).toBe(true);
  });

  test("small results at very deep depth stay full instead of becoming placeholders", async () => {
    const mediumOutput = "x".repeat(100);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: i === 0 ? mediumOutput : "ok" },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    await strategy.apply(state);

    const output = getToolResultOutput(state.prompt, "call-0");
    expect(output).toBe(mediumOutput);
    expect(capturedRemoved.some((e) => e.toolCallId === "call-0")).toBe(false);
  });

  test("pinned results are never modified", async () => {
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy();
    // Pin call-0 (would normally be placeholdered at depth 11)
    const { state, capturedRemoved } = createMockState(prompt, ["call-0"]);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe(largeOutput);
    expect(capturedRemoved.find((e) => e.toolCallId === "call-0")).toBeUndefined();
  });

  test("non-tool messages are never modified", async () => {
    const prompt = makeToolPrompt(10);
    const strategy = createDepthOnlyStrategy();
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
    const strategy = createDepthOnlyStrategy();
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
    const strategy = createDepthOnlyStrategy({ placeholder: "<removed>" });
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
    const strategy = createDepthOnlyStrategy({
      placeholder: (ctx) => {
        captured.push({ ...ctx });
        return `[${ctx.toolName}:${ctx.toolCallId}]`;
      },
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 11 should be placeholdered
    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[tool_0:call-0]");

    // Verify context was populated
    const placeholderCtx = captured.find((c) => c.toolCallId === "call-0");
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
    const strategy = createDepthOnlyStrategy();
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
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // Original prompt should be untouched
    expect(getToolResultOutput(prompt, "call-0")).toBe(largeOutput);
    // Modified prompt should have placeholder
    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[result omitted]");
  });

  test("strategy has the correct name", () => {
    const strategy = createDepthOnlyStrategy();
    expect(strategy.name).toBe("tool-result-decay");
  });

  test("large JSON outputs become placeholders once they exceed the budget and minimum source size", async () => {
    const largeJson = { data: "x".repeat(4000), nested: { key: "value" } };
    // 3 exchanges: call-0 at depth 2, call-1 at depth 1, call-2 at depth 0
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "json" as const, value: largeJson } },
      { id: "call-1", name: "tool_1", output: { type: "json" as const, value: largeJson } },
      { id: "call-2", name: "tool_2", output: { type: "json" as const, value: largeJson } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy({
      maxResultTokens: 50, // baseMaxChars = 200
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-2 at depth 0: always full
    const fullOutput = getRawToolResultOutput(state.prompt, "call-2");
    expect(fullOutput?.type).toBe("json");

    // call-1 at depth 1: budget = 200, large JSON > 200 and over the placeholder minimum
    const output1 = getRawToolResultOutput(state.prompt, "call-1");
    expect(output1?.type).toBe("text");
    if (output1?.type === "text") {
      expect(output1.value).toBe("[result omitted]");
    }

    // call-0 at depth 2: budget = 100, also placeholdered
    const output0 = getRawToolResultOutput(state.prompt, "call-0");
    expect(output0?.type).toBe("text");
    if (output0?.type === "text") {
      expect(output0.value).toBe("[result omitted]");
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
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // Small JSON should remain as JSON type everywhere (under budget at all depths)
    for (const id of ["call-0", "call-1", "call-2", "call-3", "call-4"]) {
      const output = getRawToolResultOutput(state.prompt, id);
      expect(output?.type).toBe("json");
    }
  });

  test("large content outputs become placeholders", async () => {
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
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: image content is large (~50000 chars), budget = 800
    const output = getRawToolResultOutput(state.prompt, "call-0");
    expect(output?.type).toBe("text");
    if (output?.type === "text") {
      expect(output.value).toBe("[result omitted]");
    }
  });

  test("large file content outputs become placeholders", async () => {
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
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output = getRawToolResultOutput(state.prompt, "call-0");
    expect(output?.type).toBe("text");
    if (output?.type === "text") {
      expect(output.value).toBe("[result omitted]");
    }
  });

  test("error-text output stays full when it is below the placeholder minimum source size", async () => {
    const largeError = `Error: ${"detail ".repeat(200)}`;
    // 3 exchanges
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "error-text" as const, value: largeError } },
      { id: "call-1", name: "tool_1", output: { type: "error-text" as const, value: largeError } },
      { id: "call-2", name: "tool_2", output: { type: "error-text" as const, value: largeError } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy({
      maxResultTokens: 25, // baseMaxChars = 100
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output0 = getRawToolResultOutput(state.prompt, "call-0");
    expect(output0?.type).toBe("error-text");

    const output1 = getRawToolResultOutput(state.prompt, "call-1");
    expect(output1?.type).toBe("error-text");
  });

  test("error-json output stays full when it is below the placeholder minimum source size", async () => {
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "error-json" as const, value: { error: "x".repeat(2000) } } },
      { id: "call-1", name: "tool_1", output: { type: "error-json" as const, value: { error: "x".repeat(2000) } } },
      { id: "call-2", name: "tool_2", output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy({
      maxResultTokens: 50, // baseMaxChars = 200
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output0 = getRawToolResultOutput(state.prompt, "call-0");
    expect(output0?.type).toBe("error-json");
  });

  test("execution-denied output is left untouched when it stays under budget", async () => {
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "execution-denied" as const, reason: "user denied" } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output = getRawToolResultOutput(state.prompt, "call-0");
    expect(output?.type).toBe("execution-denied");
  });

  test("mixed output types keep small structured values and placeholder large payloads", async () => {
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
    const strategy = createDepthOnlyStrategy({
      maxResultTokens: 100, // baseMaxChars = 400
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-4: depth 0 — always full
    expect(getToolResultOutput(state.prompt, "call-4")).toBe("latest result");

    // call-3: depth 1, budget = 400. Small JSON (~25 chars) → stays as JSON
    const call3 = getRawToolResultOutput(state.prompt, "call-3");
    expect(call3?.type).toBe("json");

    // call-2: depth 2, budget = 200. Large content becomes a placeholder.
    const call2 = getRawToolResultOutput(state.prompt, "call-2");
    expect(call2?.type).toBe("text");
    if (call2?.type === "text") {
      expect(call2.value).toBe("[result omitted]");
    }

    // call-1: depth 3, budget = 133. Long text becomes a placeholder.
    const call1 = getRawToolResultOutput(state.prompt, "call-1");
    expect(call1?.type).toBe("text");
    if (call1?.type === "text") {
      expect(call1.value).toBe("[result omitted]");
    }

    // call-0: depth 4 is over budget, but the JSON payload is still below the placeholder minimum size.
    const call0 = getRawToolResultOutput(state.prompt, "call-0");
    expect(call0?.type).toBe("json");
  });

  test("warning reminder emitted for large at-risk results", async () => {
    const largeOutput = "x".repeat(5000);
    const outputs = [
      { id: "call-0", name: "read_file", output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy({
      maxResultTokens: 2000, // baseMaxChars = 8000
    });
    const { state, capturedReminders } = createMockState(prompt);

    await strategy.apply(state);

    expect(capturedReminders).toHaveLength(1);
    expect(capturedReminders[0].content).toContain("call-0");
    expect(capturedReminders[0].content).toContain("placeholder");
  });

  test("warning reminder emitted for very large results exceeding baseMaxChars", async () => {
    const hugeOutput = "x".repeat(10000);
    const outputs = [
      { id: "call-0", name: "read_file", output: { type: "text" as const, value: hugeOutput } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy({
      maxResultTokens: 200, // baseMaxChars = 800
    });
    const { state, capturedReminders } = createMockState(prompt);

    await strategy.apply(state);

    expect(capturedReminders).toHaveLength(1);
    expect(capturedReminders[0].kind).toBe("tool-result-decay-warning");
    expect(capturedReminders[0].content).toContain("call-0");
    expect(capturedReminders[0].content).toContain("read_file");
    expect(capturedReminders[0].content).toContain("placeholder");
  });

  test("no warning for small results", async () => {
    const outputs = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: "small" },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy();
    const { state, capturedReminders } = createMockState(prompt);

    await strategy.apply(state);

    expect(capturedReminders).toHaveLength(0);
  });

  test("returns tool-results-decayed even when the total prompt estimate is low", async () => {
    const prompt = makeToolPromptWithOutputs([
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: "x".repeat(5000) } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: "recent" } },
    ]);
    const strategy = createDepthOnlyStrategy({
      estimator: {
        estimateMessage: () => 1,
        estimatePrompt: () => 100,
      },
    });
    const { state } = createMockState(prompt);

    const result = await strategy.apply(state);

    expect(result.reason).toBe("tool-results-decayed");
  });

  test("returns correct payload fields", async () => {
    const largeOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    const result = await strategy.apply(state);

    expect(result.reason).toBe("tool-results-decayed");
    expect(result.payloads).toHaveProperty("maxResultTokens");
    expect(result.payloads).toHaveProperty("placeholderMinSourceTokens");
    expect(result.payloads).toHaveProperty("placeholderCount");
    expect(result.payloads).toHaveProperty("inputPlaceholderCount");
    expect(result.payloads).toHaveProperty("totalToolExchanges", 5);
    expect(result.payloads).toHaveProperty("warningCount");
    // Should NOT have old fields
    expect(result.payloads).not.toHaveProperty("keepFullResultCount");
    expect(result.payloads).not.toHaveProperty("truncateWindowCount");
    expect(result.payloads).not.toHaveProperty("truncatedMaxTokens");
    expect(result.payloads).not.toHaveProperty("placeholderFloorTokens");
    expect(result.payloads).not.toHaveProperty("truncatedCount");
    expect(result.payloads).not.toHaveProperty("inputTruncatedCount");
  });

  test("older small results stay full even when they exceed the shrinking budget", async () => {
    // 5 exchanges all with 1000-char results, maxResultTokens=100 → baseMaxChars=400
    // 1000 chars is below the default placeholder minimum source size (3200 chars).
    const output = "x".repeat(1000);
    const outputs = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: output },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy({
      maxResultTokens: 100, // baseMaxChars = 400
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    for (let i = 0; i < 5; i++) {
      expect(getToolResultOutput(state.prompt, `call-${i}`)).toBe(output);
    }
  });

  test("placeholder formatter output replaces large results directly", async () => {
    // 2 exchanges: call-0 at depth 1 with large output
    const largeOutput = "x".repeat(5000);
    const entries = [
      { id: "call-0", name: "fs_write", input: { description: "Write config" }, output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", input: {}, output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = createDepthOnlyStrategy({
      placeholder: (ctx) => `[omitted: ${ctx.toolName}]`,
    });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: budget = 800. 5000 > 800 → placeholder
    const output = getToolResultOutput(state.prompt, "call-0");
    expect(output).toBeDefined();
    expect(output).toBe("[omitted: fs_write]");
  });

  test("placeholder strings replace large results directly", async () => {
    const largeOutput = "x".repeat(5000);
    const entries = [
      { id: "call-0", name: "fs_write", input: {}, output: { type: "text" as const, value: largeOutput } },
      { id: "call-1", name: "tool_1", input: {}, output: { type: "text" as const, value: "recent" } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = createDepthOnlyStrategy({ placeholder: "<removed>" });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: placeholder string is used as-is
    const output = getToolResultOutput(state.prompt, "call-0");
    expect(output).toBeDefined();
    expect(output).toBe("<removed>");
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
    const strategy = createDepthOnlyStrategy({ decayInputs: true });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 2: input is large enough to be omitted.
    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0._omitted).toBe(true);

    // call-1 at depth 1: input is also omitted.
    const input1 = getToolCallInput(state.prompt, "call-1") as Record<string, unknown>;
    expect(input1._omitted).toBe(true);

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
    const strategy = createDepthOnlyStrategy({ decayInputs: false });
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 1: large input but decayInputs=false → untouched
    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0.content).toBe("y".repeat(5000));
  });

  test("large inputs at shallow depth are omitted, small inputs stay full", async () => {
    // 3 exchanges: large input at depth 1 is omitted; small input at depth 2 stays full
    const entries = [
      { id: "call-0", name: "tool_0", input: { q: "tiny" }, output: { type: "text" as const, value: "ok" } },
      { id: "call-1", name: "fs_write", input: { content: "z".repeat(5000) }, output: { type: "text" as const, value: "ok" } },
      { id: "call-2", name: "tool_2", input: { q: "recent" }, output: { type: "text" as const, value: "ok" } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 2: input ~14 chars, budget = 800/2 = 400 → full
    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0.q).toBe("tiny");

    // call-1 at depth 1: input ~5020 chars, budget = 800 → omitted
    const input1 = getToolCallInput(state.prompt, "call-1") as Record<string, unknown>;
    expect(input1._omitted).toBe(true);
  });

  test("warning text uses formatter output when placeholder is a function", async () => {
    const hugeOutput = "x".repeat(10000);
    const entries = [
      { id: "call-0", name: "read_file", input: { description: "Read the config" }, output: { type: "text" as const, value: hugeOutput } },
    ];
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = createDepthOnlyStrategy({
      maxResultTokens: 200,
      placeholder: (ctx) => `[${ctx.toolName} id:${ctx.toolCallId}]`,
    });
    const { state, capturedReminders } = createMockState(prompt);

    await strategy.apply(state);

    expect(capturedReminders).toHaveLength(1);
    expect(capturedReminders[0].content).toContain("[read_file id:call-0]");
  });

  test("all calls in the same batch turn share depth 0 and are never immediately decayed", async () => {
    const largeOutput = "x".repeat(5000);
    // Turn 1: one previous call
    // Turn 2: 50 parallel fs_reads in one batch (same assistant message)
    const batches = [
      [{ id: "prev-call", name: "tool_prev", output: { type: "text" as const, value: "previous result" } }],
      Array.from({ length: 50 }, (_, i) => ({
        id: `batch-${i}`,
        name: "fs_read",
        output: { type: "text" as const, value: largeOutput },
      })),
    ];
    const prompt = makeToolPromptWithBatchCalls(batches);
    const strategy = createDepthOnlyStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    await strategy.apply(state);

    // All 50 batch calls are depth 0 (most recent group) → all preserved in full
    for (let i = 0; i < 50; i++) {
      expect(getToolResultOutput(state.prompt, `batch-${i}`)).toBe(largeOutput);
    }

    // The previous call is depth 1, but it is small enough to stay intact.
    const prevOutput = getToolResultOutput(state.prompt, "prev-call");
    expect(prevOutput).toBeDefined();
    expect(prevOutput).toBe("previous result");

    // No batch call should appear in removed exchanges
    expect(capturedRemoved.filter((e) => e.toolCallId.startsWith("batch-"))).toHaveLength(0);
  });

  test("payloads include inputPlaceholderCount only", async () => {
    const largeInput = { content: "y".repeat(5000) };
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      input: largeInput,
      output: { type: "text" as const, value: "ok" },
    }));
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    const result = await strategy.apply(state);

    expect(result.payloads).toHaveProperty("inputPlaceholderCount");
    expect(typeof (result.payloads as Record<string, unknown>).inputPlaceholderCount).toBe("number");
    expect(result.payloads).not.toHaveProperty("inputTruncatedCount");
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
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    // call-0 at depth 11: the large input is over budget and above the placeholder minimum.
    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0._omitted).toBe(true);
  });

  test("small inputs at very deep depth stay full instead of being omitted", async () => {
    const smallInput = { content: "y".repeat(100) };
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      input: i === 0 ? smallInput : { q: "small" },
      output: { type: "text" as const, value: "ok" },
    }));
    const prompt = makeToolPromptWithInputs(entries);
    const strategy = createDepthOnlyStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const input0 = getToolCallInput(state.prompt, "call-0") as Record<string, unknown>;
    expect(input0._omitted).toBeUndefined();
    expect(input0.content).toBe("y".repeat(100));
  });

  test("default pressure anchors keep low-token tool results intact at deep depths", async () => {
    const outputs = Array.from({ length: 11 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: "x".repeat(80) },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe("x".repeat(80));
    expect(capturedRemoved).toHaveLength(0);
  });

  test("default pressure anchors still keep medium results intact below the placeholder minimum source size", async () => {
    const largeOutput = "x".repeat(1_800);
    const outputs = Array.from({ length: 11 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output0 = getToolResultOutput(state.prompt, "call-0");
    expect(output0).toBe(largeOutput);
  });

  test("default pressure anchors placeholder around 5k-plus tool tokens by depth 11", async () => {
    const largeOutput = "x".repeat(3_500);
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: largeOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state, capturedRemoved } = createMockState(prompt);

    await strategy.apply(state);

    expect(getToolResultOutput(state.prompt, "call-0")).toBe("[result omitted]");
    expect(capturedRemoved.some((entry) => entry.toolCallId === "call-0")).toBe(true);
  });

  test("default pressure anchors still placeholder depth-1 results when tool context is above 50k tokens", async () => {
    const hugeOutput = "x".repeat(120_000);
    const outputs = [
      { id: "call-0", name: "tool_0", output: { type: "text" as const, value: hugeOutput } },
      { id: "call-1", name: "tool_1", output: { type: "text" as const, value: hugeOutput } },
    ];
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = new ToolResultDecayStrategy();
    const { state } = createMockState(prompt);

    await strategy.apply(state);

    const output0 = getToolResultOutput(state.prompt, "call-0");
    expect(output0).toBeDefined();
    expect(output0).toBe("[result omitted]");
    expect(getToolResultOutput(state.prompt, "call-1")).toBe(hugeOutput);
  });

  test("warning payloads only report placeholder transitions", async () => {
    const mediumOutput = "x".repeat(5000);
    const outputs = Array.from({ length: 5 }, (_, i) => ({
      id: `call-${i}`,
      name: `tool_${i}`,
      output: { type: "text" as const, value: mediumOutput },
    }));
    const prompt = makeToolPromptWithOutputs(outputs);
    const strategy = createDepthOnlyStrategy({ maxResultTokens: 2000 });
    const { state, capturedReminders } = createMockState(prompt);

    const result = await strategy.apply(state);

    expect(capturedReminders).toHaveLength(1);
    expect(capturedReminders[0].kind).toBe("tool-result-decay-warning");
    expect(capturedReminders[0].content).toContain("10,000");
    expect(capturedReminders[0].attributes?.tool_call_ids).toBe("call-3");
    expect(capturedReminders[0].attributes?.placeholder_ids).toBe("call-3");
    expect(capturedReminders[0].attributes).not.toHaveProperty("truncate_ids");
    expect(result.payloads).toHaveProperty("warningToolCallIds");
    expect(result.payloads).toHaveProperty("warningPlaceholderIds");
    expect(result.payloads).not.toHaveProperty("warningTruncateIds");
    expect((result.payloads as Record<string, unknown>).warningToolCallIds).toEqual(["call-3"]);
    expect((result.payloads as Record<string, unknown>).warningPlaceholderIds).toEqual(["call-3"]);
  });
});
