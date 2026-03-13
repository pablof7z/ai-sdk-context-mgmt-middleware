import { ScratchpadStrategy } from "../index.js";
import { InMemoryScratchpadStore, makePrompt } from "./helpers.js";

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
      removedToolExchanges: [] as any[],
      updatePrompt(nextPrompt: any) {
        this.prompt = nextPrompt;
      },
      addRemovedToolExchanges(exchanges: any[]) {
        this.removedToolExchanges = [...this.removedToolExchanges, ...exchanges];
      },
    };

    await strategy.apply(state as any);

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
      removedToolExchanges: [] as any[],
      updatePrompt(nextPrompt: any) {
        this.prompt = nextPrompt;
      },
      addRemovedToolExchanges(exchanges: any[]) {
        this.removedToolExchanges = [...this.removedToolExchanges, ...exchanges];
      },
    };

    await strategy.apply(state as any);

    expect(state.prompt.filter((message: any) => message.role !== "system")).toHaveLength(2);
  });
});
