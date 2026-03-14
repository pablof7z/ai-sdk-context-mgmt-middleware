import { ScratchpadStrategy } from "../index.js";
import { appendReminderToLatestUserMessage } from "../prompt-utils.js";
import { InMemoryScratchpadStore, makePrompt } from "./helpers.js";

function emitReminderToPrompt(state: { prompt: any; updatePrompt: (prompt: any) => void }, reminder: { content: string }) {
  state.updatePrompt(appendReminderToLatestUserMessage(state.prompt, reminder.content));
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

    expect(result).toEqual({
      ok: true,
      state: expect.objectContaining({
        notes: "Focus on parser cleanup",
        keepLastMessages: 3,
        omitToolCallIds: ["call-1"],
        agentLabel: "Alpha",
      }),
    });
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
      maxRemovedToolReminderItems: 1,
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
    const state = {
      requestContext: {
        conversationId: "conv-1",
        agentId: "agent-1",
        agentLabel: "Alpha",
      },
      prompt,
      params: { prompt, providerOptions: {} },
      pinnedToolCallIds: new Set<string>(),
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
      addPinnedToolCallIds() {},
      async emitReminder(reminder: { content: string }) {
        emitReminderToPrompt(this, reminder);
      },
    };

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
    expect(reminderText).toContain("Removed tool exchanges:");
    expect(reminderText).toContain("fs_read (call-old)");
    expect(reminderText).toContain("and 1 more");
    expect(reminderText).toContain("You can update these notes or future omissions with scratchpad(...).");
    expect(reminderText).not.toContain("Use scratchpad(...) now");
    expect(result).toEqual({
      reason: "scratchpad-rendered",
      payloads: expect.objectContaining({
        currentState: expect.objectContaining({
          notes: "Keep the working set tight.",
        }),
        appliedOmitToolCallIds: ["call-old", "call-older"],
        reminderTone: "informational",
        reminderText: expect.stringContaining("You can update these notes"),
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
    const state = {
      requestContext: {
        conversationId: "conv-1",
        agentId: "agent-1",
      },
      prompt: alreadySmallPrompt,
      params: { prompt: alreadySmallPrompt, providerOptions: {} },
      pinnedToolCallIds: new Set<string>(),
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
      addPinnedToolCallIds() {},
      async emitReminder(reminder: { content: string }) {
        emitReminderToPrompt(this, reminder);
      },
    };

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
    const pinnedToolCallIds = new Set<string>(["call-old"]);
    const state = {
      requestContext: {
        conversationId: "conv-1",
        agentId: "agent-1",
      },
      prompt: makePrompt(),
      params: { prompt: makePrompt(), providerOptions: {} },
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
    const state = {
      requestContext: {
        conversationId: "conv-1",
        agentId: "agent-1",
      },
      prompt,
      params: { prompt, providerOptions: {} },
      pinnedToolCallIds: new Set<string>(),
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
      addPinnedToolCallIds() {},
      async emitReminder(reminder: { content: string }) {
        emitReminderToPrompt(this, reminder);
      },
    };

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
    const state = {
      requestContext: {
        conversationId: "conv-1",
        agentId: "agent-1",
      },
      prompt,
      params: { prompt, providerOptions: {} },
      pinnedToolCallIds: new Set<string>(),
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
      addPinnedToolCallIds() {},
      async emitReminder(reminder: { content: string }) {
        emitReminderToPrompt(this, reminder);
      },
    };

    const result = await strategy.apply(state as any);

    expect(state.params.toolChoice).toBeUndefined();
    expect(result).toEqual(
      expect.objectContaining({
        reason: "scratchpad-rendered",
        payloads: expect.objectContaining({
          forcedToolChoice: false,
          latestToolActivity: expect.objectContaining({
            toolName: "scratchpad",
            type: "tool-result",
          }),
        }),
      })
    );
  });
});
