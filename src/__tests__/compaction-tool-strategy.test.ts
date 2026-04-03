import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { CompactionToolStrategy } from "../index.js";
import type {
  CompactionState,
  CompactionStore,
  CompactionStoreKey,
  ContextManagementStrategyState,
  RemovedToolExchange,
} from "../types.js";

function makeAddressablePrompt(): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "Investigate parser issue" }] },
    { role: "assistant", content: [{ type: "text", text: "I opened the parser files." }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-old", toolName: "fs_read", input: { path: "parser.ts" } }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-old", toolName: "fs_read", output: { type: "text", value: "parser contents" } }],
    },
    { role: "user", content: [{ type: "text", text: "The tokenizer still fails on comments." }] },
    { role: "assistant", content: [{ type: "text", text: "I traced it to the old comment branch." }] },
    { role: "user", content: [{ type: "text", text: "Please continue with the fix." }] },
  ];

  return prompt.map((message, index) => message.role === "system"
    ? { ...message, id: `system:${index}` }
    : {
      ...message,
      id: `message:${index}`,
      sourceRecordId: `record:${index}`,
      eventId: `event:${index}`,
    } as LanguageModelV3Message
  );
}

function makeState(
  prompt: LanguageModelV3Prompt,
  requestContext: { conversationId: string; agentId: string; agentLabel?: string } = {
    conversationId: "conv-1",
    agentId: "agent-1",
    agentLabel: "executor",
  },
  pinnedIds: string[] = []
) {
  const pinnedToolCallIds = new Set(pinnedIds);
  return {
    prompt,
    pinnedToolCallIds,
    removedToolExchanges: [] as RemovedToolExchange[],
    requestContext,
    params: { prompt, providerOptions: {} },
    updatePrompt(p: LanguageModelV3Prompt) {
      this.prompt = p;
      this.params = { ...this.params, prompt: p };
    },
    updateParams(patch: Partial<{ prompt: LanguageModelV3Prompt }>) {
      this.params = { ...this.params, ...patch };
      if (patch.prompt) {
        this.prompt = patch.prompt;
      }
    },
    addRemovedToolExchanges(e: RemovedToolExchange[]) {
      this.removedToolExchanges.push(...e);
    },
    addPinnedToolCallIds(ids: string[]) {
      for (const id of ids) {
        pinnedToolCallIds.add(id);
      }
    },
    emitReminder: async () => {},
  };
}

function cloneState(state: CompactionState): CompactionState {
  return {
    ...state,
    edits: state.edits.map((edit) => ({
      ...edit,
      start: { ...edit.start },
      end: { ...edit.end },
    })),
  };
}

class InMemoryCompactionStore implements CompactionStore {
  private readonly values = new Map<string, CompactionState>();

  private key(key: CompactionStoreKey): string {
    return `${key.conversationId}:${key.agentId}`;
  }

  async get(key: CompactionStoreKey): Promise<CompactionState | undefined> {
    const value = this.values.get(this.key(key));
    return value ? cloneState(value) : undefined;
  }

  async set(key: CompactionStoreKey, state: CompactionState): Promise<void> {
    this.values.set(this.key(key), cloneState(state));
  }
}

describe("CompactionToolStrategy", () => {
  test("returns compact_context in optional tools", () => {
    const strategy = new CompactionToolStrategy({});

    const tools = strategy.getOptionalTools();
    expect(tools).toHaveProperty("compact_context");
  });

  test("manual compact_context queues and applies a selected span", async () => {
    const store = new InMemoryCompactionStore();
    const onCompact = async ({ steeringMessage }: { steeringMessage?: string }) =>
      steeringMessage
        ? `Host summary: ${steeringMessage}`
        : "Host summary: parser investigation complete.";
    const strategy = new CompactionToolStrategy({
      compactionStore: store,
      onCompact,
    });
    const prompt = makeAddressablePrompt();

    const result = await strategy.getOptionalTools().compact_context.execute?.(
      {
        from: "Investigate parser issue",
        to: "old comment branch",
        guidance: "Parser investigation complete. The old comment branch caused the failure.",
      },
      {
        toolCallId: "tool-call-1",
        messages: prompt as never[],
        experimental_context: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
            agentLabel: "executor",
          },
        },
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        compactedMessageCount: 6,
      })
    );

    const state = makeState(prompt);
    await strategy.apply(state as unknown as ContextManagementStrategyState);

    expect(state.prompt.some((message) =>
      message.role === "assistant"
      && JSON.stringify(message.content).includes("Host summary: Parser investigation complete. The old comment branch caused the failure.")
    )).toBe(true);
    expect(state.prompt.some((message) => JSON.stringify(message.content).includes("Please continue with the fix."))).toBe(true);
    expect(state.removedToolExchanges).toEqual([
      {
        toolCallId: "call-old",
        toolName: "fs_read",
        reason: "compaction",
      },
    ]);

    const stored = await store.get({ conversationId: "conv-1", agentId: "agent-1" });
    expect(stored?.edits).toHaveLength(1);
    expect(stored?.edits[0]?.start.sourceRecordId).toBe("record:1");
    expect(stored?.edits[0]?.end.sourceRecordId).toBe("record:6");
    expect(stored?.edits[0]?.steeringMessage).toBe(
      "Parser investigation complete. The old comment branch caused the failure."
    );
  });

  test("omitted anchors compact the full eligible historical span", async () => {
    const store = new InMemoryCompactionStore();
    const strategy = new CompactionToolStrategy({
      compactionStore: store,
      onCompact: async () => "Older parser investigation summarized.",
    });
    const prompt = makeAddressablePrompt();

    const result = await strategy.getOptionalTools().compact_context.execute?.(
      {},
      {
        toolCallId: "tool-call-2",
        messages: prompt as never[],
        experimental_context: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
          },
        },
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        compactedMessageCount: 6,
      })
    );

    const state = makeState(prompt);
    await strategy.apply(state as unknown as ContextManagementStrategyState);

    expect(state.prompt.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "user",
    ]);
  });

  test("rejects ambiguous manual matches", async () => {
    const strategy = new CompactionToolStrategy({
      onCompact: async () => "unused",
    });
    const basePrompt = makeAddressablePrompt();
    const prompt = [
      ...basePrompt.slice(0, 7),
      {
        role: "assistant",
        content: [{ type: "text", text: "I opened the parser files again." }],
        id: "message:extra",
        sourceRecordId: "record:extra",
        eventId: "event:extra",
      } as LanguageModelV3Message,
      ...basePrompt.slice(7),
    ];

    const result = await strategy.getOptionalTools().compact_context.execute?.(
      {
        from: "opened the parser files",
        guidance: "ambiguous",
      },
      {
        toolCallId: "tool-call-3",
        messages: prompt as never[],
        experimental_context: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
          },
        },
      }
    );

    expect(result).toEqual({
      ok: false,
      error: "The `from` excerpt matched multiple messages. Use a more specific excerpt.",
    });
  });

  test("rejects manual compaction that targets the protected active tail", async () => {
    const strategy = new CompactionToolStrategy({
      onCompact: async () => "unused",
    });
    const prompt = makeAddressablePrompt();

    const result = await strategy.getOptionalTools().compact_context.execute?.(
      {
        from: "Please continue with the fix.",
        guidance: "should fail",
      },
      {
        toolCallId: "tool-call-4",
        messages: prompt as never[],
        experimental_context: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
          },
        },
      }
    );

    expect(result).toEqual({
      ok: false,
      error: "The `from` excerpt did not match any eligible historical user or assistant message.",
    });
  });

  test("manual compact_context is unavailable without a host summarizer", async () => {
    const strategy = new CompactionToolStrategy({});
    const prompt = makeAddressablePrompt();

    const result = await strategy.getOptionalTools().compact_context.execute?.(
      {},
      {
        toolCallId: "tool-call-unavailable",
        messages: prompt as never[],
        experimental_context: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
          },
        },
      }
    );

    expect(result).toEqual({
      ok: false,
      error: "compact_context is unavailable because no host compaction summarizer is configured.",
    });
  });

  test("stored compactions reapply and stale edits are pruned", async () => {
    const store = new InMemoryCompactionStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        edits: [{
          id: "edit-1",
          source: "manual",
          start: { sourceRecordId: "record:1" },
          end: { sourceRecordId: "record:6" },
          replacement: "Stored parser summary",
          createdAt: 1,
          compactedMessageCount: 6,
        }],
      }
    );

    const strategy = new CompactionToolStrategy({
      compactionStore: store,
    });

    const state = makeState(makeAddressablePrompt());
    await strategy.apply(state as unknown as ContextManagementStrategyState);
    expect(state.prompt.some((message) => JSON.stringify(message.content).includes("Stored parser summary"))).toBe(true);

    const prunedPrompt = makeAddressablePrompt().filter((message) =>
      (message as { sourceRecordId?: string }).sourceRecordId !== "record:6"
    );
    const prunedState = makeState(prunedPrompt);
    await strategy.apply(prunedState as unknown as ContextManagementStrategyState);

    expect(prunedState.prompt.some((message) => JSON.stringify(message.content).includes("Stored parser summary"))).toBe(false);
    expect((await store.get({ conversationId: "conv-1", agentId: "agent-1" }))?.edits).toEqual([]);
  });

  test("auto compaction can absorb earlier compaction summaries into one fresh summary", async () => {
    const store = new InMemoryCompactionStore();
    await store.set(
      { conversationId: "conv-1", agentId: "agent-1" },
      {
        edits: [{
          id: "edit-old",
          source: "manual",
          start: { sourceRecordId: "record:1" },
          end: { sourceRecordId: "record:2" },
          replacement: "Old parser summary",
          createdAt: 1,
          compactedMessageCount: 2,
        }],
      }
    );

    let receivedMessages: LanguageModelV3Message[] = [];
    const strategy = new CompactionToolStrategy({
      compactionStore: store,
      preserveRecentMessages: 1,
      shouldCompact: () => true,
      onCompact: async ({ messages }) => {
        receivedMessages = messages;
        return "Collapsed history summary";
      },
    });

    const state = makeState(makeAddressablePrompt());
    await strategy.apply(state as unknown as ContextManagementStrategyState);

    expect(receivedMessages.some((message) =>
      message.role === "assistant"
      && JSON.stringify(message.content).includes("Old parser summary")
    )).toBe(true);
    expect(state.prompt.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "user",
    ]);

    const stored = await store.get({ conversationId: "conv-1", agentId: "agent-1" });
    expect(stored?.edits).toHaveLength(1);
    expect(stored?.edits[0]?.replacement).toBe("Collapsed history summary");
  });
});
