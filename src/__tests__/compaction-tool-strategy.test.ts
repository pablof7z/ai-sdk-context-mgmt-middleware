import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { CompactionToolStrategy } from "../compaction-tool-strategy.js";
import type {
  CompactionStore,
  CompactionStoreKey,
  ContextManagementStrategyState,
  RemovedToolExchange,
} from "../types.js";
import { makePrompt } from "./helpers.js";

function makeState(
  prompt: LanguageModelV3Prompt,
  requestContext: { conversationId: string; agentId: string } = { conversationId: "conv-1", agentId: "agent-1" },
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
  };
}

class InMemoryCompactionStore implements CompactionStore {
  private readonly values = new Map<string, string>();

  private key(key: CompactionStoreKey): string {
    return `${key.conversationId}:${key.agentId}`;
  }

  async get(key: CompactionStoreKey): Promise<string | undefined> {
    return this.values.get(this.key(key));
  }

  async set(key: CompactionStoreKey, summary: string): Promise<void> {
    this.values.set(this.key(key), summary);
  }
}

describe("CompactionToolStrategy", () => {
  test("returns compact_context in optional tools", () => {
    const strategy = new CompactionToolStrategy({
      summarize: async () => "summary",
    });

    const tools = strategy.getOptionalTools();
    expect(tools).toHaveProperty("compact_context");
    expect(tools.compact_context).toBeDefined();
  });

  test("no-op on apply when no compaction pending and no stored summary", async () => {
    const strategy = new CompactionToolStrategy({
      summarize: async () => "summary",
    });

    const prompt = makePrompt();
    const state = makeState(prompt);
    const originalLength = state.prompt.length;

    await strategy.apply(state as unknown as ContextManagementStrategyState);

    expect(state.prompt.length).toBe(originalLength);
    expect(state.removedToolExchanges).toEqual([]);
  });

  test("injects stored summary as system message on apply", async () => {
    const store = new InMemoryCompactionStore();
    await store.set({ conversationId: "conv-1", agentId: "agent-1" }, "Previous conversation summary.");

    const strategy = new CompactionToolStrategy({
      summarize: async () => "summary",
      compactionStore: store,
    });

    const prompt = makePrompt();
    const state = makeState(prompt);

    await strategy.apply(state as unknown as ContextManagementStrategyState);

    const summaryMessage = state.prompt.find(
      (m) =>
        m.role === "system" &&
        (m.providerOptions as Record<string, unknown>)?.contextManagement &&
        ((m.providerOptions as Record<string, Record<string, unknown>>).contextManagement).type === "compaction-summary"
    );
    expect(summaryMessage).toBeDefined();
    expect((summaryMessage as { content: string }).content).toBe("Previous conversation summary.");
  });

  test("after tool is called, next apply triggers summarization", async () => {
    let summarizeCalled = false;
    const strategy = new CompactionToolStrategy({
      summarize: async (messages) => {
        summarizeCalled = true;
        return `Summarized ${messages.length} messages`;
      },
      keepLastMessages: 2,
    });

    const compactTool = strategy.getOptionalTools().compact_context;
    await compactTool.execute?.(
      {},
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

    const prompt = makePrompt();
    const state = makeState(prompt);

    await strategy.apply(state as unknown as ContextManagementStrategyState);

    expect(summarizeCalled).toBe(true);

    const summaryMessage = state.prompt.find(
      (m) =>
        m.role === "system" &&
        (m.providerOptions as Record<string, unknown>)?.contextManagement &&
        ((m.providerOptions as Record<string, Record<string, unknown>>).contextManagement).type === "compaction-summary"
    );
    expect(summaryMessage).toBeDefined();
    expect((summaryMessage as { content: string }).content).toContain("Summarized");
  });

  test("pending compaction is scoped to the calling conversation and agent", async () => {
    let summarizeCalled = false;
    const strategy = new CompactionToolStrategy({
      summarize: async () => {
        summarizeCalled = true;
        return "summary";
      },
      keepLastMessages: 2,
    });

    const compactTool = strategy.getOptionalTools().compact_context;
    await compactTool.execute?.(
      {},
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

    const unrelatedState = makeState(makePrompt(), { conversationId: "conv-2", agentId: "agent-2" });
    await strategy.apply(unrelatedState as unknown as ContextManagementStrategyState);

    expect(summarizeCalled).toBe(false);
  });

  test("summary is persisted to store", async () => {
    const store = new InMemoryCompactionStore();
    const strategy = new CompactionToolStrategy({
      summarize: async () => "Persisted summary text",
      keepLastMessages: 2,
      compactionStore: store,
    });

    const compactTool = strategy.getOptionalTools().compact_context;
    await compactTool.execute?.(
      {},
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

    const state = makeState(makePrompt());
    await strategy.apply(state as unknown as ContextManagementStrategyState);

    const stored = await store.get({ conversationId: "conv-1", agentId: "agent-1" });
    expect(stored).toBe("Persisted summary text");
  });

  test("reports removed tool exchanges", async () => {
    const strategy = new CompactionToolStrategy({
      summarize: async () => "summary",
      keepLastMessages: 1,
    });

    const compactTool = strategy.getOptionalTools().compact_context;
    await compactTool.execute?.(
      {},
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

    const state = makeState(makePrompt());
    await strategy.apply(state as unknown as ContextManagementStrategyState);

    expect(state.removedToolExchanges.length).toBeGreaterThan(0);
    expect(state.removedToolExchanges[0].toolCallId).toBe("call-old");
    expect(state.removedToolExchanges[0].toolName).toBe("fs_read");
    expect(state.removedToolExchanges[0].reason).toBe("compaction");
  });

  test("preserves a tool exchange when the tail boundary would otherwise split it", async () => {
    const strategy = new CompactionToolStrategy({
      summarize: async (messages) => `summary:${messages.length}`,
      keepLastMessages: 2,
    });

    const compactTool = strategy.getOptionalTools().compact_context;
    await compactTool.execute?.(
      {},
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

    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "older" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-boundary", toolName: "read", input: { path: "a.ts" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-boundary", toolName: "read", output: { type: "text", value: "contents" } }],
      },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ];

    const state = makeState(prompt);
    await strategy.apply(state as unknown as ContextManagementStrategyState);

    expect(state.prompt.some((message) =>
      message.role !== "system" &&
      message.content.some((part) =>
        (part.type === "tool-call" || part.type === "tool-result") && part.toolCallId === "call-boundary"
      )
    )).toBe(true);
  });
});
