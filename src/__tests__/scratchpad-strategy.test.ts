import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { ScratchpadStrategy } from "../index.js";
import { appendReminderToLatestUserMessage } from "../prompt-utils.js";
import { InMemoryScratchpadStore, makePrompt } from "./helpers.js";

function emitReminderToPrompt(state: { prompt: any; updatePrompt: (prompt: any) => void }, reminder: { content: string }) {
  state.updatePrompt(appendReminderToLatestUserMessage(state.prompt, reminder.content));
}

function makeState(prompt: LanguageModelV3Prompt, pinnedIds: string[] = []) {
  const pinnedToolCallIds = new Set(pinnedIds);
  const state = {
    requestContext: {
      conversationId: "conv-1",
      agentId: "agent-1",
      agentLabel: "Alpha",
    },
    prompt,
    params: { prompt, providerOptions: {} },
    pinnedToolCallIds,
    removedToolExchanges: [] as any[],
    updatePrompt(nextPrompt: any) {
      this.prompt = nextPrompt;
    },
    updateParams(patch: any) {
      this.params = { ...this.params, ...patch };
      if (patch.prompt) {
        this.prompt = patch.prompt;
      }
    },
    addRemovedToolExchanges(exchanges: any[]) {
      this.removedToolExchanges = [...this.removedToolExchanges, ...exchanges];
    },
    addPinnedToolCallIds(ids: string[]) {
      for (const id of ids) {
        pinnedToolCallIds.add(id);
      }
    },
    async emitReminder(reminder: { content: string }) {
      emitReminderToPrompt(this, reminder);
    },
  };
  return state;
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

/**
 * Build a 10-message (non-system) prompt for head-and-tail testing.
 * Layout:
 *   0: system
 *   1: user "msg-1"       (original task)
 *   2: assistant "msg-2"  (first response)
 *   3: user "msg-3"
 *   4: assistant "msg-4"  <- tool-call "call-mid"
 *   5: tool               <- tool-result "call-mid"
 *   6: user "msg-6"
 *   7: assistant "msg-7"
 *   8: user "msg-8"
 *   9: assistant "msg-9"
 *  10: user "msg-10"
 *  11: assistant "msg-11"
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
    { role: "assistant", content: [{ type: "text", text: "msg-11" }] },
  ];
}

describe("ScratchpadStrategy", () => {
  test("scratchpad tool updates only the caller state using experimental_context", async () => {
    const store = new InMemoryScratchpadStore();
    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const scratchpadTool = strategy.getOptionalTools?.().scratchpad;

    const result = await scratchpadTool.execute?.(
      {
        notes: "Focus on parser cleanup",
        keepLastMessages: 3,
        omitToolCallIds: ["call-1"],
      },
      {
        toolCallId: "tool-call-1",
        messages: [],
        experimental_context: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
            agentLabel: "Alpha",
          },
        },
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        state: expect.objectContaining({
          notes: "Focus on parser cleanup",
          keepLastMessages: 3,
          omitToolCallIds: ["call-1"],
        }),
      })
    );
    expect(await store.get({ conversationId: "conv-1", agentId: "agent-1" })).toEqual(
      expect.objectContaining({
        notes: "Focus on parser cleanup",
        keepLastMessages: 3,
        omitToolCallIds: ["call-1"],
      })
    );
    expect(await store.get({ conversationId: "conv-1", agentId: "agent-2" })).toBeUndefined();
  });

  test("applies explicit omissions and injects attributed reminders", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        notes: "Keep the working set tight.",
        omitToolCallIds: ["call-old", "call-older"],
      }
    );
    await store.set(
      { conversationId: "conv-1", agentId: "agent-2" },
      {
        notes: "I already inspected the CLI wiring.",
        omitToolCallIds: [],
        agentLabel: "Beta",
      }
    );

    const strategy = new ScratchpadStrategy({
      scratchpadStore: store,
    });
    const prompt = [
      ...makePrompt(),
      {
        role: "assistant" as const,
        content: [{ type: "tool-call" as const, toolCallId: "call-older", toolName: "shell", input: { command: "git status" } }],
      },
      {
        role: "tool" as const,
        content: [{ type: "tool-result" as const, toolCallId: "call-older", toolName: "shell", output: { type: "text" as const, value: "clean" } }],
      },
    ];
    const state = makeState(prompt);

    const result = await strategy.apply(state as any);

    expect(
      state.prompt.some((message: any) =>
        message.content?.some?.((part: any) =>
          (part.type === "tool-call" || part.type === "tool-result") && part.toolCallId === "call-old"
        )
      )
    ).toBe(false);
    expect(
      state.prompt.some((message: any) =>
        message.content?.some?.((part: any) =>
          (part.type === "tool-call" || part.type === "tool-result") && part.toolCallId === "call-older"
        )
      )
    ).toBe(false);

    const latestUserMessage = [...state.prompt].reverse().find((message: any) => message.role === "user");
    const reminderText = latestUserMessage?.content.at(-1)?.text ?? "";

    expect(reminderText).toContain("Your scratchpad (Alpha)");
    expect(reminderText).toContain("Keep the working set tight.");
    expect(reminderText).toContain("Other agent scratchpads:");
    expect(reminderText).toContain("Beta: I already inspected the CLI wiring.");
    expect(reminderText).not.toContain("Removed tool exchanges:");
    expect(reminderText).toContain("You can update these notes or future omissions with scratchpad(...).");
    expect(reminderText).not.toContain("Use scratchpad(...) now");
    expect(result).toEqual({
      reason: "scratchpad-rendered",
      payloads: expect.objectContaining({
        notesCharCount: "Keep the working set tight.".length,
        appliedOmitCount: 2,
        reminderTone: "informational",
      }),
    });
  });

  test("keepLastMessages only shrinks the current prompt", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        notes: "",
        keepLastMessages: 10,
        omitToolCallIds: [],
      }
    );

    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const alreadySmallPrompt = makePrompt().slice(-2);
    const state = makeState(alreadySmallPrompt);

    await strategy.apply(state as any);

    expect(state.prompt.filter((message: any) => message.role !== "system")).toHaveLength(2);
  });

  test("pinned tool exchanges are preserved against scratchpad omission and trimming", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        notes: "",
        keepLastMessages: 0,
        omitToolCallIds: ["call-old"],
      }
    );

    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const state = makeState(makePrompt(), ["call-old"]);

    await strategy.apply(state as any);

    expect(
      state.prompt.some((message: any) =>
        message.content?.some?.((part: any) =>
          (part.type === "tool-call" || part.type === "tool-result") && part.toolCallId === "call-old"
        )
      )
    ).toBe(true);
  });

  test("forces scratchpad tool choice once the configured threshold is crossed", async () => {
    const store = new InMemoryScratchpadStore();
    const prompt = [
      ...makePrompt(),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-new",
            toolName: "fs_read",
            input: { path: "new.ts" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call-new",
            toolName: "fs_read",
            output: { type: "text" as const, value: "x".repeat(800) },
          },
        ],
      },
    ];
    const strategy = new ScratchpadStrategy({
      scratchpadStore: store,
      workingTokenBudget: 100,
      forceToolThresholdRatio: 0.7,
      estimator: {
        estimateMessage: () => 10,
        estimatePrompt: () => 80,
      },
    });
    const state = makeState(prompt);

    const result = await strategy.apply(state as any);

    expect(state.params.toolChoice).toEqual({
      type: "tool",
      toolName: "scratchpad",
    });
    expect(result).toEqual(
      expect.objectContaining({
        outcome: "applied",
        reason: "scratchpad-rendered-and-tool-forced",
        workingTokenBudget: 100,
        payloads: expect.objectContaining({
          forcedToolChoice: true,
          forceThresholdTokens: 70,
        }),
      })
    );
  });

  test("does not immediately re-force scratchpad after a scratchpad call/result", async () => {
    const store = new InMemoryScratchpadStore();
    const prompt = [
      {
        role: "system" as const,
        content: "You are helpful.",
      },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "scratch-call-1",
            toolName: "scratchpad",
            input: { notes: "keep parser state" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "scratch-call-1",
            toolName: "scratchpad",
            output: { type: "json" as const, value: { ok: true } },
          },
        ],
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Continue." }],
      },
    ];
    const strategy = new ScratchpadStrategy({
      scratchpadStore: store,
      workingTokenBudget: 100,
      forceToolThresholdRatio: 0.7,
      estimator: {
        estimateMessage: () => 10,
        estimatePrompt: () => 80,
      },
    });
    const state = makeState(prompt);

    const result = await strategy.apply(state as any);

    expect(state.params.toolChoice).toBeUndefined();
    expect(result).toEqual(
      expect.objectContaining({
        reason: "scratchpad-rendered",
        payloads: expect.objectContaining({
          forcedToolChoice: false,
          latestToolName: "scratchpad",
        }),
      })
    );
  });

  describe("head-and-tail trimming", () => {
    test("keepLastMessages=2 preserves head and tail, drops middle", async () => {
      const store = new InMemoryScratchpadStore();
      await store.set(
        { conversationId: "conv-1", agentId: "agent-1" },
        {
          notes: "working on poems",
          keepLastMessages: 2,
          omitToolCallIds: [],
        }
      );

      // preserveHeadCount defaults to 2
      const strategy = new ScratchpadStrategy({ scratchpadStore: store });
      const prompt = makeLargePrompt(); // 10 non-system messages
      const state = makeState(prompt);

      await strategy.apply(state as any);

      const texts = state.prompt.map(textOf).filter((t) => t !== undefined);

      // Head: first 2 non-system messages (msg-1, msg-2)
      expect(texts).toContain("msg-1");
      expect(texts).toContain("msg-2");

      // Tail: last 2 non-system messages (msg-10, msg-11)
      expect(texts).toContain("msg-10");
      expect(texts).toContain("msg-11");

      // System always preserved
      expect(texts).toContain("You are helpful.");

      // Middle should be dropped
      expect(texts).not.toContain("msg-3");
      expect(texts).not.toContain("msg-6");
      expect(texts).not.toContain("msg-7");
    });

    test("keepLastMessages preserves pinned tool exchanges in the middle", async () => {
      const store = new InMemoryScratchpadStore();
      await store.set(
        { conversationId: "conv-1", agentId: "agent-1" },
        {
          notes: "",
          keepLastMessages: 2,
          omitToolCallIds: [],
        }
      );

      const strategy = new ScratchpadStrategy({ scratchpadStore: store });
      const prompt = makeLargePrompt();
      // Pin call-mid which is in the middle of the prompt
      const state = makeState(prompt, ["call-mid"]);

      await strategy.apply(state as any);

      const texts = state.prompt.map(textOf).filter((t) => t !== undefined);

      // Pinned exchange should be preserved
      expect(texts).toContain("tool-call:call-mid");
      expect(texts).toContain("tool-result:call-mid");

      // Head preserved
      expect(texts).toContain("msg-1");
      expect(texts).toContain("msg-2");

      // Tail preserved
      expect(texts).toContain("msg-10");
      expect(texts).toContain("msg-11");
    });

    test("custom preserveHeadCount changes how many head messages are kept", async () => {
      const store = new InMemoryScratchpadStore();
      await store.set(
        { conversationId: "conv-1", agentId: "agent-1" },
        {
          notes: "",
          keepLastMessages: 2,
          omitToolCallIds: [],
        }
      );

      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        preserveHeadCount: 4,
      });
      const prompt = makeLargePrompt();
      const state = makeState(prompt);

      await strategy.apply(state as any);

      const texts = state.prompt.map(textOf).filter((t) => t !== undefined);

      // Head: first 4 non-system messages
      expect(texts).toContain("msg-1");
      expect(texts).toContain("msg-2");
      expect(texts).toContain("msg-3");
      expect(texts).toContain("tool-call:call-mid");

      // Tail: last 2
      expect(texts).toContain("msg-10");
      expect(texts).toContain("msg-11");

      // Middle dropped
      expect(texts).not.toContain("msg-7");
    });
  });

  describe("forced scratchpad error", () => {
    test("returns error when forced and agent provides no pruning params", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        workingTokenBudget: 100,
        forceToolThresholdRatio: 0.7,
        estimator: {
          estimateMessage: () => 10,
          estimatePrompt: () => 80,
        },
      });

      // First, apply to trigger the force
      const prompt = makeLargePrompt();
      const state = makeState(prompt);
      await strategy.apply(state as any);

      // Verify force was triggered
      expect(state.params.toolChoice).toEqual({
        type: "tool",
        toolName: "scratchpad",
      });

      // Now call the tool with only notes (no pruning params)
      const scratchpadTool = strategy.getOptionalTools?.().scratchpad;
      const result = await scratchpadTool.execute?.(
        {
          notes: "I saved my progress but didn't prune",
        },
        {
          toolCallId: "tool-call-forced",
          messages: [],
          experimental_context: {
            contextManagement: {
              conversationId: "conv-1",
              agentId: "agent-1",
            },
          },
        }
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Context is critically full");
      expect(result.error).toContain("keepLastMessages");
      // Notes should still be saved
      expect(result.state).toEqual(
        expect.objectContaining({
          notes: "I saved my progress but didn't prune",
        })
      );
    });

    test("returns ok when forced and agent provides keepLastMessages", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        workingTokenBudget: 100,
        forceToolThresholdRatio: 0.7,
        estimator: {
          estimateMessage: () => 10,
          estimatePrompt: () => 80,
        },
      });

      // Trigger the force
      const prompt = makeLargePrompt();
      const state = makeState(prompt);
      await strategy.apply(state as any);

      // Call the tool with keepLastMessages
      const scratchpadTool = strategy.getOptionalTools?.().scratchpad;
      const result = await scratchpadTool.execute?.(
        {
          notes: "Saved progress",
          keepLastMessages: 5,
        },
        {
          toolCallId: "tool-call-forced",
          messages: [],
          experimental_context: {
            contextManagement: {
              conversationId: "conv-1",
              agentId: "agent-1",
            },
          },
        }
      );

      expect(result.ok).toBe(true);
      expect(result.state).toEqual(
        expect.objectContaining({
          notes: "Saved progress",
          keepLastMessages: 5,
        })
      );
    });

    test("returns ok when forced and agent provides omitToolCallIds", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        workingTokenBudget: 100,
        forceToolThresholdRatio: 0.7,
        estimator: {
          estimateMessage: () => 10,
          estimatePrompt: () => 80,
        },
      });

      // Trigger the force
      const prompt = makeLargePrompt();
      const state = makeState(prompt);
      await strategy.apply(state as any);

      // Call the tool with omitToolCallIds
      const scratchpadTool = strategy.getOptionalTools?.().scratchpad;
      const result = await scratchpadTool.execute?.(
        {
          notes: "Saved progress",
          omitToolCallIds: ["call-mid"],
        },
        {
          toolCallId: "tool-call-forced",
          messages: [],
          experimental_context: {
            contextManagement: {
              conversationId: "conv-1",
              agentId: "agent-1",
            },
          },
        }
      );

      expect(result.ok).toBe(true);
    });

    test("does not error on non-forced calls without pruning params", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({ scratchpadStore: store });
      const scratchpadTool = strategy.getOptionalTools?.().scratchpad;

      const result = await scratchpadTool.execute?.(
        {
          notes: "Just saving notes",
        },
        {
          toolCallId: "tool-call-1",
          messages: [],
          experimental_context: {
            contextManagement: {
              conversationId: "conv-1",
              agentId: "agent-1",
            },
          },
        }
      );

      expect(result.ok).toBe(true);
    });
  });

  describe("forced scratchpad reminder", () => {
    test("includes CRITICAL guidance when force is triggered", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        workingTokenBudget: 100,
        forceToolThresholdRatio: 0.7,
        estimator: {
          estimateMessage: () => 10,
          estimatePrompt: () => 80,
        },
      });
      const prompt = makeLargePrompt();
      const state = makeState(prompt);

      await strategy.apply(state as any);

      const latestUserMessage = [...state.prompt].reverse().find((message: any) => message.role === "user");
      const reminderText = latestUserMessage?.content.at(-1)?.text ?? "";

      expect(reminderText).toContain("CRITICAL: Context is nearly full");
      expect(reminderText).toContain("Record any side-effect actions in notes");
      expect(reminderText).toContain("Set keepLastMessages to trim old messages");
      expect(reminderText).toContain("Failure to free context will result in an error");
    });

    test("does not include CRITICAL guidance when force is not triggered", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        workingTokenBudget: 100,
        forceToolThresholdRatio: 0.7,
        estimator: {
          estimateMessage: () => 10,
          estimatePrompt: () => 50, // Below threshold
        },
      });
      const prompt = makeLargePrompt();
      const state = makeState(prompt);

      await strategy.apply(state as any);

      const latestUserMessage = [...state.prompt].reverse().find((message: any) => message.role === "user");
      const reminderText = latestUserMessage?.content.at(-1)?.text ?? "";

      expect(reminderText).not.toContain("CRITICAL");
      expect(reminderText).toContain("You can update these notes");
    });
  });
});
