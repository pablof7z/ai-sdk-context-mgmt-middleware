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
 * Build a 10-message (non-system) prompt for head-preserving trim testing.
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

function makeAnchoredPrompt(): LanguageModelV3Prompt {
  return [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "msg-1" }] },
    { role: "assistant", content: [{ type: "text", text: "msg-2" }] },
    { role: "user", content: [{ type: "text", text: "msg-3" }] },
    { role: "assistant", content: [{ type: "text", text: "msg-4" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "scratch-call-1", toolName: "scratchpad", input: { keepLastMessages: 1 } }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "scratch-call-1", toolName: "scratchpad", output: { type: "json", value: { ok: true } } }],
    },
    { role: "assistant", content: [{ type: "text", text: "after-scratchpad" }] },
    { role: "user", content: [{ type: "text", text: "future-1" }] },
    { role: "assistant", content: [{ type: "text", text: "future-2" }] },
    { role: "user", content: [{ type: "text", text: "future-3" }] },
  ];
}

describe("ScratchpadStrategy", () => {
  test("scratchpad tool updates only the caller state using experimental_context", async () => {
    const store = new InMemoryScratchpadStore();
    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const scratchpadTool = strategy.getOptionalTools?.().scratchpad;

    const result = await scratchpadTool.execute?.(
      {
        setEntries: {
          notes: "Focus on parser cleanup",
        },
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
      })
    );
    expect(await store.get({ conversationId: "conv-1", agentId: "agent-1" })).toEqual(
      expect.objectContaining({
        entries: {
          notes: "Focus on parser cleanup",
        },
        keepLastMessages: 3,
        keepLastMessagesAnchorToolCallId: "tool-call-1",
        omitToolCallIds: ["call-1"],
      })
    );
    expect(await store.get({ conversationId: "conv-1", agentId: "agent-2" })).toBeUndefined();
  });

  test("scratchpad tool supports key/value entry updates without special note handling", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        entries: {
          notes: "Existing notes rewritten by the model",
          objective: "Inspect the parser flow",
          stale: "remove me",
        },
        omitToolCallIds: [],
      }
    );

    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const scratchpadTool = strategy.getOptionalTools?.().scratchpad;

    const result = await scratchpadTool.execute?.(
      {
        setEntries: {
          findings: "Tool ordering still looks correct",
          notes: "Fresh follow-up",
        },
        removeEntryKeys: ["stale"],
      },
      {
        toolCallId: "tool-call-2",
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

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(await store.get({ conversationId: "conv-1", agentId: "agent-1" })).toEqual(
      expect.objectContaining({
        entries: {
          findings: "Tool ordering still looks correct",
          notes: "Fresh follow-up",
          objective: "Inspect the parser flow",
        },
      })
    );
  });

  test("applies explicit omissions and injects attributed reminders", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        entries: {
          notes: "Parser follow-up is still open.",
          objective: "Keep the working set tight.",
        },
        omitToolCallIds: ["call-old", "call-older"],
      }
    );
    await store.set(
      { conversationId: "conv-1", agentId: "agent-2" },
      {
        entries: {
          findings: "I already inspected the CLI wiring.",
        },
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
    expect(reminderText).toContain("objective: Keep the working set tight.");
    expect(reminderText).toContain("notes: Parser follow-up is still open.");
    expect(reminderText).toContain("Other agent scratchpads:");
    expect(reminderText).toContain("- Beta:");
    expect(reminderText).toContain("findings: I already inspected the CLI wiring.");
    expect(reminderText).not.toContain("Removed tool exchanges:");
    expect(reminderText).toContain("Use scratchpad(...) proactively to keep this working state current.");
    expect(reminderText).not.toContain("Use scratchpad(...) now");
    expect(result).toEqual({
      reason: "scratchpad-rendered",
      payloads: expect.objectContaining({
        entryCount: 2,
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
            input: { setEntries: { notes: "keep parser state" } },
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

  describe("head-preserving trimming", () => {
    test("keepLastMessages anchors trimming at the scratchpad call and preserves future messages", async () => {
      const store = new InMemoryScratchpadStore();
      await store.set(
        { conversationId: "conv-1", agentId: "agent-1" },
        {
          entries: {
            notes: "working on poems",
          },
          keepLastMessages: 1,
          keepLastMessagesAnchorToolCallId: "scratch-call-1",
          omitToolCallIds: [],
        }
      );

      const strategy = new ScratchpadStrategy({ scratchpadStore: store });
      const prompt = makeAnchoredPrompt();
      const state = makeState(prompt);

      await strategy.apply(state as any);

      const texts = state.prompt.map(textOf).filter((t) => t !== undefined);

      expect(texts).toContain("msg-1");
      expect(texts).toContain("msg-2");
      expect(texts).toContain("msg-4");
      expect(texts).toContain("tool-call:scratch-call-1");
      expect(texts).toContain("tool-result:scratch-call-1");
      expect(texts).toContain("after-scratchpad");
      expect(texts).toContain("future-1");
      expect(texts).toContain("future-2");
      expect(texts).toContain("future-3");
      expect(texts).toContain("You are helpful.");
      expect(texts).not.toContain("msg-3");
    });

    test("keepLastMessages=0 still preserves everything after the scratchpad call", async () => {
      const store = new InMemoryScratchpadStore();
      await store.set(
        { conversationId: "conv-1", agentId: "agent-1" },
        {
          keepLastMessages: 0,
          keepLastMessagesAnchorToolCallId: "scratch-call-1",
          omitToolCallIds: [],
        }
      );

      const strategy = new ScratchpadStrategy({ scratchpadStore: store });
      const prompt = makeAnchoredPrompt();
      const state = makeState(prompt);

      await strategy.apply(state as any);

      const texts = state.prompt.map(textOf).filter((t) => t !== undefined);

      expect(texts).toContain("msg-1");
      expect(texts).toContain("msg-2");
      expect(texts).toContain("tool-call:scratch-call-1");
      expect(texts).toContain("tool-result:scratch-call-1");
      expect(texts).toContain("future-3");
      expect(texts).not.toContain("msg-3");
      expect(texts).not.toContain("msg-4");
    });

    test("falls back to the latest scratchpad tool call when anchor is missing from stored state", async () => {
      const store = new InMemoryScratchpadStore();
      await store.set(
        { conversationId: "conv-1", agentId: "agent-1" },
        {
          keepLastMessages: 1,
          omitToolCallIds: [],
        }
      );

      const strategy = new ScratchpadStrategy({ scratchpadStore: store });
      const prompt = makeAnchoredPrompt();
      const state = makeState(prompt);

      await strategy.apply(state as any);

      const texts = state.prompt.map(textOf).filter((t) => t !== undefined);

      expect(texts).toContain("msg-1");
      expect(texts).toContain("msg-2");
      expect(texts).toContain("msg-4");
      expect(texts).toContain("future-3");
      expect(texts).not.toContain("msg-3");
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

      // Now call the tool with scratchpad entries only (no pruning params)
      const scratchpadTool = strategy.getOptionalTools?.().scratchpad;
      const result = await scratchpadTool.execute?.(
        {
          setEntries: {
            notes: "I saved my progress but didn't prune",
          },
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
      // Scratchpad updates should still be saved in the store
      const saved = await store.get({ conversationId: "conv-1", agentId: "agent-1" });
      expect(saved).toEqual(
        expect.objectContaining({
          entries: {
            notes: "I saved my progress but didn't prune",
          },
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
          setEntries: {
            notes: "Saved progress",
          },
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
      const saved = await store.get({ conversationId: "conv-1", agentId: "agent-1" });
      expect(saved).toEqual(
        expect.objectContaining({
          entries: {
            notes: "Saved progress",
          },
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
          setEntries: {
            notes: "Saved progress",
          },
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
          setEntries: {
            notes: "Just saving notes",
          },
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
      expect(reminderText).toContain("Record side-effect actions in your scratchpad");
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
      expect(reminderText).toContain("Suggested entry names for this run");
      expect(reminderText).toContain("Use scratchpad(...) proactively");
    });
  });
});
