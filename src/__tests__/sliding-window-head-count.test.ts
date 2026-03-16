import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { SlidingWindowStrategy } from "../index.js";
import type { RemovedToolExchange } from "../types.js";

function makeState(prompt: LanguageModelV3Prompt, pinnedIds: string[] = []) {
  const captured: RemovedToolExchange[] = [];
  const pinnedToolCallIds = new Set(pinnedIds);
  const state = {
    prompt,
    pinnedToolCallIds,
    removedToolExchanges: [] as readonly RemovedToolExchange[],
    updatePrompt(p: LanguageModelV3Prompt) {
      this.prompt = p;
    },
    updateParams() {},
    addRemovedToolExchanges(exchanges: RemovedToolExchange[]) {
      captured.push(...exchanges);
    },
    addPinnedToolCallIds(ids: string[]) {
      for (const id of ids) {
        pinnedToolCallIds.add(id);
      }
    },
  };
  return { state: state as any, captured };
}

/**
 * Build a prompt with 12 non-system messages and 1 system message at index 0.
 * Layout (by original index):
 *   0: system
 *   1: user "msg-1"
 *   2: assistant "msg-2"
 *   3: user "msg-3"
 *   4: assistant "msg-4"   <- tool-call "call-mid"
 *   5: tool                <- tool-result "call-mid"
 *   6: user "msg-6"
 *   7: assistant "msg-7"
 *   8: user "msg-8"
 *   9: assistant "msg-9"
 *  10: user "msg-10"
 *  11: assistant "msg-11"  <- tool-call "call-tail"
 *  12: tool                <- tool-result "call-tail"
 */
function makeLargePrompt(): LanguageModelV3Prompt {
  return [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "msg-1" }] },
    { role: "assistant", content: [{ type: "text", text: "msg-2" }] },
    { role: "user", content: [{ type: "text", text: "msg-3" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-mid", toolName: "search", input: { q: "x" } }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-mid", toolName: "search", output: { type: "text", value: "result" } }],
    },
    { role: "user", content: [{ type: "text", text: "msg-6" }] },
    { role: "assistant", content: [{ type: "text", text: "msg-7" }] },
    { role: "user", content: [{ type: "text", text: "msg-8" }] },
    { role: "assistant", content: [{ type: "text", text: "msg-9" }] },
    { role: "user", content: [{ type: "text", text: "msg-10" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-tail", toolName: "read", input: { path: "b.ts" } }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-tail", toolName: "read", output: { type: "text", value: "file" } }],
    },
  ];
}

function textOf(message: any): string | undefined {
  if (message.role === "system") return message.content;
  for (const part of message.content) {
    if (part.type === "text") return part.text;
    if (part.type === "tool-call") return `tool-call:${part.toolCallId}`;
    if (part.type === "tool-result") return `tool-result:${part.toolCallId}`;
  }
  return undefined;
}

describe("SlidingWindowStrategy with headCount", () => {
  test("keeps head and tail messages, drops the middle", () => {
    // head=2, tail=4 => keep first 2 + last 4 non-system, drop middle 6
    const strategy = new SlidingWindowStrategy({ headCount: 2, keepLastMessages: 4 });
    const prompt = makeLargePrompt();
    const { state } = makeState(prompt);

    strategy.apply(state);

    const texts = state.prompt.map(textOf);
    // System always kept
    expect(texts[0]).toBe("You are helpful.");
    // Head: msg-1, msg-2
    expect(texts).toContain("msg-1");
    expect(texts).toContain("msg-2");
    // Tail: msg-10, tool-call:call-tail, tool-result:call-tail + one more before
    expect(texts).toContain("msg-10");
    expect(texts).toContain("tool-call:call-tail");
    expect(texts).toContain("tool-result:call-tail");
    // Middle should be dropped
    expect(texts).not.toContain("msg-3");
    expect(texts).not.toContain("msg-6");
  });

  test("system messages are always kept regardless of position", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system-1" },
      { role: "user", content: [{ type: "text", text: "msg-1" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-2" }] },
      { role: "system", content: "system-mid" },
      { role: "user", content: [{ type: "text", text: "msg-3" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-4" }] },
      { role: "user", content: [{ type: "text", text: "msg-5" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-6" }] },
      { role: "user", content: [{ type: "text", text: "msg-7" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-8" }] },
    ];

    // 8 non-system messages, head=1, tail=2 => drop middle 5
    const strategy = new SlidingWindowStrategy({ headCount: 1, keepLastMessages: 2 });
    const { state } = makeState(prompt);

    strategy.apply(state);

    const texts = state.prompt.map(textOf);
    // Both system messages should be present
    expect(texts).toContain("system-1");
    expect(texts).toContain("system-mid");
    // Head
    expect(texts).toContain("msg-1");
    // Tail
    expect(texts).toContain("msg-7");
    expect(texts).toContain("msg-8");
    // Middle dropped
    expect(texts).not.toContain("msg-2");
    expect(texts).not.toContain("msg-3");
    expect(texts).not.toContain("msg-4");
    expect(texts).not.toContain("msg-5");
  });

  test("tool-call/tool-result pairs are not split at the head boundary", () => {
    // Tool call at the edge of head, result just outside => should expand head
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "msg-1" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-edge", toolName: "search", input: {} }],
      },
      // This result is index 2 in non-system, which would normally be in the dropped zone with head=2
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-edge", toolName: "search", output: { type: "text", value: "r" } }],
      },
      { role: "user", content: [{ type: "text", text: "msg-4" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-5" }] },
      { role: "user", content: [{ type: "text", text: "msg-6" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-7" }] },
      { role: "user", content: [{ type: "text", text: "msg-8" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-9" }] },
    ];

    // 9 non-system messages. head=2, tail=3 => normally keep non-system 0-1, 6-8
    // But non-system index 1 is tool-call:call-edge, result is at non-system index 2
    // So head should expand to include index 2
    const strategy = new SlidingWindowStrategy({ headCount: 2, keepLastMessages: 3 });
    const { state } = makeState(prompt);

    strategy.apply(state);

    const texts = state.prompt.map(textOf);
    // Both parts of the tool exchange should be present
    expect(texts).toContain("tool-call:call-edge");
    expect(texts).toContain("tool-result:call-edge");
  });

  test("tool-call/tool-result pairs are not split at the tail boundary", () => {
    // Tool result at the start of tail, call just before in drop zone => should expand tail
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "msg-1" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-2" }] },
      { role: "user", content: [{ type: "text", text: "msg-3" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-4" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-boundary", toolName: "read", input: {} }],
      },
      // Tool result is at non-system index 5, which starts the tail with tail=3
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-boundary", toolName: "read", output: { type: "text", value: "r" } }],
      },
      { role: "user", content: [{ type: "text", text: "msg-7" }] },
      { role: "assistant", content: [{ type: "text", text: "msg-8" }] },
    ];

    // 8 non-system messages. head=2, tail=3 => normally keep non-system 0-1, 5-7
    // But non-system index 5 is tool-result:call-boundary, call is at non-system index 4 (drop zone)
    // So tail should expand backward to include the call
    const strategy = new SlidingWindowStrategy({ headCount: 2, keepLastMessages: 3 });
    const { state } = makeState(prompt);

    strategy.apply(state);

    const texts = state.prompt.map(textOf);
    expect(texts).toContain("tool-call:call-boundary");
    expect(texts).toContain("tool-result:call-boundary");
  });

  test("removed tool exchanges are reported", () => {
    const strategy = new SlidingWindowStrategy({ headCount: 2, keepLastMessages: 4 });
    const prompt = makeLargePrompt();
    const { state, captured } = makeState(prompt);

    strategy.apply(state);

    // call-mid is in the middle and should be dropped
    const midExchange = captured.find((e) => e.toolCallId === "call-mid");
    expect(midExchange).toBeDefined();
    expect(midExchange!.toolName).toBe("search");
    expect(midExchange!.reason).toBe("sliding-window");

    // call-tail is in the tail and should NOT be removed
    const tailExchange = captured.find((e) => e.toolCallId === "call-tail");
    expect(tailExchange).toBeUndefined();
  });

  test("pinned exchanges stay in the prompt even when they fall in the dropped middle", () => {
    const strategy = new SlidingWindowStrategy({ headCount: 2, keepLastMessages: 4 });
    const prompt = makeLargePrompt();
    const { state, captured } = makeState(prompt, ["call-mid"]);

    strategy.apply(state);

    const texts = state.prompt.map(textOf);
    expect(texts).toContain("tool-call:call-mid");
    expect(texts).toContain("tool-result:call-mid");
    expect(captured.find((exchange) => exchange.toolCallId === "call-mid")).toBeUndefined();
  });

  test("no-op when messages fit within headCount + keepLastMessages", () => {
    const strategy = new SlidingWindowStrategy({ headCount: 5, keepLastMessages: 10 });
    const prompt = makeLargePrompt(); // 12 non-system messages, 5+10=15 > 12
    const { state, captured } = makeState(prompt);

    strategy.apply(state);

    // Prompt should be unchanged (same references since no clone needed)
    expect(state.prompt.length).toBe(prompt.length);
    expect(captured).toEqual([]);
  });

  test("uses default keepLastMessages=8 when headCount is set", () => {
    const strategy = new SlidingWindowStrategy({ headCount: 2 });
    const prompt = makeLargePrompt(); // 12 non-system messages, 2+8=10 < 12
    const { state } = makeState(prompt);

    strategy.apply(state);

    // With head=2, tail=8: drop zone is non-system positions 2-3 (messages 3,4).
    // But message 4 is tool-call "call-mid" whose result is at message 5 (in tail).
    // Tail expands backward to include the tool-call, so only 1 message is dropped.
    const nonSystem = state.prompt.filter((m: any) => m.role !== "system");
    expect(nonSystem.length).toBe(11);
  });

  test("has name property set to sliding-window", () => {
    const strategy = new SlidingWindowStrategy({ headCount: 2 });
    expect(strategy.name).toBe("sliding-window");
  });
});
