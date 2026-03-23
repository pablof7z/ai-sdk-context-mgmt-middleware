import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { ScratchpadStrategy } from "../index.js";
import { appendReminderToLatestUserMessage } from "../prompt-utils.js";
import { InMemoryScratchpadStore, makePrompt } from "./helpers.js";

function emitReminderToPrompt(state: { prompt: LanguageModelV3Prompt; updatePrompt: (prompt: LanguageModelV3Prompt) => void }, reminder: { content: string }) {
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
    removedToolExchanges: [] as Array<{ toolCallId: string; toolName: string; reason: string }>,
    updatePrompt(nextPrompt: LanguageModelV3Prompt) {
      this.prompt = nextPrompt;
    },
    updateParams(patch: Record<string, unknown>) {
      this.params = { ...this.params, ...patch };
      if ("prompt" in patch && patch.prompt) {
        this.prompt = patch.prompt as LanguageModelV3Prompt;
      }
    },
    addRemovedToolExchanges(exchanges: Array<{ toolCallId: string; toolName: string; reason: string }>) {
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

function user(text: string): Extract<LanguageModelV3Message, { role: "user" }> {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistantText(text: string): Extract<LanguageModelV3Message, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function assistantToolCall(toolCallId: string, toolName = "search"): Extract<LanguageModelV3Message, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input: { q: toolCallId } }],
  };
}

function assistantMixed(text: string, toolCallId: string, toolName = "search"): Extract<LanguageModelV3Message, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool-call", toolCallId, toolName, input: { q: toolCallId } },
    ],
  };
}

function toolResult(toolCallId: string, toolName = "search", value = "result"): Extract<LanguageModelV3Message, { role: "tool" }> {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value } }],
  };
}

function firstText(message: LanguageModelV3Message): string | undefined {
  if (message.role === "system") {
    return typeof message.content === "string" ? message.content : undefined;
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content.find((part) => part.type === "text")?.text;
}

function visibleSequence(prompt: LanguageModelV3Prompt): string[] {
  return prompt.flatMap((message) => {
    const text = firstText(message);
    return text === undefined ? [] : [`${message.role}:${text}`];
  });
}

function latestUserReminderText(prompt: LanguageModelV3Prompt): string {
  const latestUserMessage = [...prompt].reverse().find((message) => message.role === "user");
  if (!latestUserMessage || typeof latestUserMessage.content === "string") {
    return "";
  }

  return latestUserMessage.content.at(-1)?.type === "text"
    ? latestUserMessage.content.at(-1)?.text ?? ""
    : "";
}

describe("ScratchpadStrategy", () => {
  test("scratchpad tool persists preserveTurns and the active notice for the caller only", async () => {
    const store = new InMemoryScratchpadStore();
    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const scratchpadTool = strategy.getOptionalTools?.().scratchpad;

    const result = await scratchpadTool.execute?.(
      {
        description: "Saving parser state",
        setEntries: {
          notes: "Focus on parser cleanup",
        },
        preserveTurns: 2,
        omitToolCallIds: ["call-1"],
      },
      {
        toolCallId: "tool-call-1",
        messages: [
          { role: "system", content: "You are helpful." },
          user("1"),
          assistantText("ok, 1"),
          user("2"),
          assistantText("ok, 2"),
        ],
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
          notes: "Focus on parser cleanup",
        },
        preserveTurns: 2,
        activeNotice: {
          description: "Saving parser state",
          toolCallId: "tool-call-1",
          rawTurnCountAtCall: 2,
          projectedTurnCountAtCall: 2,
        },
        omitToolCallIds: ["call-1"],
      })
    );
    expect(await store.get({ conversationId: "conv-1", agentId: "agent-2" })).toBeUndefined();
  });

  test("scratchpad tool requires description", async () => {
    const store = new InMemoryScratchpadStore();
    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const scratchpadTool = strategy.getOptionalTools?.().scratchpad;

    await expect(
      scratchpadTool.execute?.(
        {
          setEntries: {
            notes: "Missing description",
          },
        } as never,
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
      )
    ).rejects.toThrow();
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
        activeNotice: {
          description: "Saving parser state",
          toolCallId: "scratchpad-call-1",
          rawTurnCountAtCall: 2,
          projectedTurnCountAtCall: 2,
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
      assistantToolCall("call-older", "shell"),
      toolResult("call-older", "shell", "clean"),
    ];
    const state = makeState(prompt);

    const result = await strategy.apply(state as never);

    expect(state.prompt.some((message) => message.role === "tool")).toBe(false);
    expect(
      state.prompt.some((message) =>
        message.role === "assistant"
        && message.content.some((part) => part.type === "tool-call" || part.type === "tool-result")
      )
    ).toBe(false);

    const reminderText = latestUserReminderText(state.prompt);
    expect(reminderText).toContain("Your scratchpad (Alpha)");
    expect(reminderText).toContain("objective: Keep the working set tight.");
    expect(reminderText).toContain("notes: Parser follow-up is still open.");
    expect(reminderText).toContain("Other agent scratchpads:");
    expect(reminderText).toContain("- Beta:");
    expect(reminderText).toContain("findings: I already inspected the CLI wiring.");
    expect(reminderText).toContain("Use scratchpad(...) proactively to keep this working state current.");
    expect(result).toEqual({
      reason: "scratchpad-rendered",
      payloads: expect.objectContaining({
        entryCount: 2,
        appliedOmitCount: 2,
        reminderTone: "informational",
        activeNoticeDescription: "Saving parser state",
      }),
    });
  });

  test("does not inject built-in empty-state guidance by default, but renders host guidance when configured", async () => {
    const defaultStore = new InMemoryScratchpadStore();
    const defaultStrategy = new ScratchpadStrategy({
      scratchpadStore: defaultStore,
    });
    const defaultState = makeState(makePrompt());

    await defaultStrategy.apply(defaultState as never);

    const defaultReminderText = latestUserReminderText(defaultState.prompt);
    expect(defaultReminderText).not.toContain("Suggested entry names for this run:");
    expect(defaultReminderText).toContain("Use scratchpad(...) proactively to keep this working state current.");

    const configuredStore = new InMemoryScratchpadStore();
    const configuredStrategy = new ScratchpadStrategy({
      scratchpadStore: configuredStore,
      emptyStateGuidance: "If helpful, common scratchpad keys include: objective, findings, notes, side-effects, and next-steps. Use any keys that fit the work.",
    });
    const configuredState = makeState(makePrompt());

    await configuredStrategy.apply(configuredState as never);

    expect(latestUserReminderText(configuredState.prompt)).toContain(
      "If helpful, common scratchpad keys include: objective, findings, notes, side-effects, and next-steps. Use any keys that fit the work."
    );
  });

  test("projects semantic head and tail turns, pairing assistant text across intervening tool messages", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        preserveTurns: 1,
        activeNotice: {
          description: "Compacting earlier work",
          toolCallId: "scratchpad-call-1",
          rawTurnCountAtCall: 4,
          projectedTurnCountAtCall: 2,
        },
        omitToolCallIds: [],
      }
    );

    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const state = makeState([
      { role: "system", content: "You are helpful." },
      user("1"),
      assistantText("ok, 1"),
      user("2"),
      assistantToolCall("call-2"),
      toolResult("call-2"),
      assistantText("ok, 2"),
      user("3"),
      assistantMixed("ok, 3", "call-3"),
      toolResult("call-3"),
      user("4"),
      assistantText("ok, 4"),
    ]);

    await strategy.apply(state as never);

    expect(visibleSequence(state.prompt)).toEqual([
      "system:You are helpful.",
      "user:1",
      "assistant:ok, 1",
      "assistant:<system-reminder>[scratchpad used: Compacting earlier work]</system-reminder>",
      "user:4",
      "assistant:ok, 4",
    ]);
    expect(state.prompt.some((message) => message.role === "tool")).toBe(false);
    expect(
      state.prompt.some((message) =>
        message.role === "assistant"
        && message.content.some((part) => part.type === "tool-call" || part.type === "tool-result")
      )
    ).toBe(false);
  });

  test("preserves future turns after an earlier scratchpad compaction", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        preserveTurns: 1,
        activeNotice: {
          description: "Saved working state",
          toolCallId: "scratchpad-call-1",
          rawTurnCountAtCall: 4,
          projectedTurnCountAtCall: 2,
        },
        omitToolCallIds: [],
      }
    );

    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const state = makeState([
      { role: "system", content: "You are helpful." },
      user("1"),
      assistantText("ok, 1"),
      user("2"),
      assistantText("ok, 2"),
      user("3"),
      assistantText("ok, 3"),
      user("4"),
      assistantText("ok, 4"),
      user("5"),
      assistantText("ok, 5"),
      user("6"),
      assistantText("ok, 6"),
    ]);

    await strategy.apply(state as never);

    expect(visibleSequence(state.prompt)).toEqual([
      "system:You are helpful.",
      "user:1",
      "assistant:ok, 1",
      "assistant:<system-reminder>[scratchpad used: Saved working state]</system-reminder>",
      "user:4",
      "assistant:ok, 4",
      "user:5",
      "assistant:ok, 5",
      "user:6",
      "assistant:ok, 6",
    ]);
  });

  test("a newer scratchpad call replaces the older visible notice", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        preserveTurns: 1,
        activeNotice: {
          description: "Fresher scratchpad state",
          toolCallId: "scratchpad-call-2",
          rawTurnCountAtCall: 6,
          projectedTurnCountAtCall: 2,
        },
        omitToolCallIds: [],
      }
    );

    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const state = makeState([
      { role: "system", content: "You are helpful." },
      user("1"),
      assistantText("ok, 1"),
      assistantText("<system-reminder>[scratchpad used: stale]</system-reminder>"),
      user("4"),
      assistantText("ok, 4"),
      user("5"),
      assistantText("ok, 5"),
      user("6"),
      assistantText("ok, 6"),
    ]);

    await strategy.apply(state as never);

    expect(visibleSequence(state.prompt)).toEqual([
      "system:You are helpful.",
      "user:1",
      "assistant:ok, 1",
      "assistant:<system-reminder>[scratchpad used: Fresher scratchpad state]</system-reminder>",
      "user:6",
      "assistant:ok, 6",
    ]);
    expect(JSON.stringify(state.prompt)).not.toContain("[scratchpad used: stale]");
  });

  test("preserves the newest unmatched user request even when preserveTurns is zero", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        preserveTurns: 0,
        activeNotice: {
          description: "Dropping answered turns",
          toolCallId: "scratchpad-call-1",
          rawTurnCountAtCall: 3,
          projectedTurnCountAtCall: 1,
        },
        omitToolCallIds: [],
      }
    );

    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const state = makeState([
      { role: "system", content: "You are helpful." },
      user("1"),
      assistantText("ok, 1"),
      user("2"),
      assistantText("ok, 2"),
      user("3"),
    ]);

    await strategy.apply(state as never);

    expect(visibleSequence(state.prompt)).toEqual([
      "system:You are helpful.",
      "assistant:<system-reminder>[scratchpad used: Dropping answered turns]</system-reminder>",
      "user:3",
    ]);
  });

  test("pinned tool exchanges are not counted as omitted even though tool use is hidden by turn projection", async () => {
    const store = new InMemoryScratchpadStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        activeNotice: {
          description: "Saving state",
          toolCallId: "scratchpad-call-1",
          rawTurnCountAtCall: 2,
          projectedTurnCountAtCall: 2,
        },
        omitToolCallIds: ["call-old"],
      }
    );

    const strategy = new ScratchpadStrategy({ scratchpadStore: store });
    const state = makeState(makePrompt(), ["call-old"]);

    await strategy.apply(state as never);

    expect(state.removedToolExchanges.map((exchange) => exchange.toolCallId)).not.toContain("call-old");
    expect(state.prompt.some((message) => message.role === "tool")).toBe(false);
  });

  test("forces scratchpad tool choice once the configured threshold is crossed", async () => {
    const store = new InMemoryScratchpadStore();
    const prompt = [
      ...makePrompt(),
      assistantToolCall("call-new", "fs_read"),
      toolResult("call-new", "fs_read", "x".repeat(800)),
    ];
    const strategy = new ScratchpadStrategy({
      scratchpadStore: store,
      budgetProfile: {
        tokenBudget: 100,
        estimator: {
          estimateMessage: () => 10,
          estimatePrompt: () => 80,
        },
      },
      forceToolThresholdRatio: 0.7,
    });
    const state = makeState(prompt);

    const result = await strategy.apply(state as never);

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
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are helpful." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "scratch-call-1",
            toolName: "scratchpad",
            input: { description: "Saving notes", setEntries: { notes: "keep parser state" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "scratch-call-1",
            toolName: "scratchpad",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
      user("Continue."),
    ];
    const strategy = new ScratchpadStrategy({
      scratchpadStore: store,
      budgetProfile: {
        tokenBudget: 100,
        estimator: {
          estimateMessage: () => 10,
          estimatePrompt: () => 80,
        },
      },
      forceToolThresholdRatio: 0.7,
    });
    const state = makeState(prompt);

    const result = await strategy.apply(state as never);

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

  describe("forced scratchpad error", () => {
    test("returns error when forced and agent provides no pruning params", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        budgetProfile: {
          tokenBudget: 100,
          estimator: {
            estimateMessage: () => 10,
            estimatePrompt: () => 80,
          },
        },
        forceToolThresholdRatio: 0.7,
      });

      const state = makeState([
        { role: "system", content: "You are helpful." },
        user("1"),
        assistantText("ok, 1"),
        user("2"),
        assistantText("ok, 2"),
        user("3"),
        assistantText("ok, 3"),
        user("4"),
        assistantText("ok, 4"),
      ]);
      await strategy.apply(state as never);

      expect(state.params.toolChoice).toEqual({
        type: "tool",
        toolName: "scratchpad",
      });

      const scratchpadTool = strategy.getOptionalTools?.().scratchpad;
      const result = await scratchpadTool.execute?.(
        {
          description: "Saving only notes",
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
      expect(result.error).toContain("preserveTurns");
      const saved = await store.get({ conversationId: "conv-1", agentId: "agent-1" });
      expect(saved).toEqual(
        expect.objectContaining({
          entries: {
            notes: "I saved my progress but didn't prune",
          },
        })
      );
    });

    test("returns ok when forced and agent provides preserveTurns", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        budgetProfile: {
          tokenBudget: 100,
          estimator: {
            estimateMessage: () => 10,
            estimatePrompt: () => 80,
          },
        },
        forceToolThresholdRatio: 0.7,
      });

      const state = makeState([
        { role: "system", content: "You are helpful." },
        user("1"),
        assistantText("ok, 1"),
        user("2"),
        assistantText("ok, 2"),
        user("3"),
        assistantText("ok, 3"),
        user("4"),
        assistantText("ok, 4"),
      ]);
      await strategy.apply(state as never);

      const scratchpadTool = strategy.getOptionalTools?.().scratchpad;
      const result = await scratchpadTool.execute?.(
        {
          description: "Compacting older turns",
          setEntries: {
            notes: "Saved progress",
          },
          preserveTurns: 2,
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
      expect(await store.get({ conversationId: "conv-1", agentId: "agent-1" })).toEqual(
        expect.objectContaining({
          entries: {
            notes: "Saved progress",
          },
          preserveTurns: 2,
        })
      );
    });
  });

  describe("forced scratchpad reminder", () => {
    test("includes CRITICAL guidance when force is triggered", async () => {
      const store = new InMemoryScratchpadStore();
      const strategy = new ScratchpadStrategy({
        scratchpadStore: store,
        budgetProfile: {
          tokenBudget: 100,
          estimator: {
            estimateMessage: () => 10,
            estimatePrompt: () => 80,
          },
        },
        forceToolThresholdRatio: 0.7,
      });
      const state = makeState([
        { role: "system", content: "You are helpful." },
        user("1"),
        assistantText("ok, 1"),
        user("2"),
        assistantText("ok, 2"),
        user("3"),
        assistantText("ok, 3"),
        user("4"),
        assistantText("ok, 4"),
      ]);

      await strategy.apply(state as never);

      const reminderText = latestUserReminderText(state.prompt);
      expect(reminderText).toContain("CRITICAL: Context is nearly full");
      expect(reminderText).toContain("Record side-effect actions in your scratchpad");
      expect(reminderText).toContain("Set preserveTurns to compact older turns");
      expect(reminderText).toContain("Failure to free context will result in an error");
    });
  });
});
