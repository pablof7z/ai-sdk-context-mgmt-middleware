import { PinnedMessagesStrategy } from "../pinned-messages-strategy.js";
import type { PinnedStore, PinnedStoreKey, ContextManagementStrategyState, RemovedToolExchange } from "../types.js";
import { makePrompt } from "./helpers.js";

class InMemoryPinnedStore implements PinnedStore {
  private readonly values = new Map<string, string[]>();

  private key(key: PinnedStoreKey): string {
    return `${key.conversationId}:${key.agentId}`;
  }

  async get(key: PinnedStoreKey): Promise<string[]> {
    return [...(this.values.get(this.key(key)) ?? [])];
  }

  async set(key: PinnedStoreKey, toolCallIds: string[]): Promise<void> {
    this.values.set(this.key(key), [...toolCallIds]);
  }
}

function makeState(prompt: ReturnType<typeof makePrompt>) {
  const pinnedToolCallIds = new Set<string>();
  return {
    prompt,
    pinnedToolCallIds: pinnedToolCallIds as ReadonlySet<string>,
    removedToolExchanges: [] as RemovedToolExchange[],
    requestContext: { conversationId: "conv-1", agentId: "agent-1" },
    params: { prompt, providerOptions: {} },
    updatePrompt(p: typeof prompt) { this.prompt = p; },
    updateParams() {},
    addRemovedToolExchanges(e: RemovedToolExchange[]) { this.removedToolExchanges.push(...e); },
    addPinnedToolCallIds(ids: string[]) { for (const id of ids) pinnedToolCallIds.add(id); },
  } as unknown as ContextManagementStrategyState & { pinnedToolCallIds: Set<string> };
}

function makeToolContext(conversationId = "conv-1", agentId = "agent-1") {
  return {
    toolCallId: "tool-call-pin",
    messages: [],
    experimental_context: {
      contextManagement: { conversationId, agentId },
    },
  };
}

describe("PinnedMessagesStrategy", () => {
  test("returns pin_tool_result in optional tools", () => {
    const store = new InMemoryPinnedStore();
    const strategy = new PinnedMessagesStrategy({ pinnedStore: store });
    const tools = strategy.getOptionalTools?.();

    expect(tools).toBeDefined();
    expect(tools!.pin_tool_result).toBeDefined();
  });

  test("apply() loads pinned IDs from store and adds to state", async () => {
    const store = new InMemoryPinnedStore();
    await store.set({ conversationId: "conv-1", agentId: "agent-1" }, ["call-1", "call-2"]);

    const strategy = new PinnedMessagesStrategy({ pinnedStore: store });
    const state = makeState(makePrompt());

    await strategy.apply(state);

    expect(state.pinnedToolCallIds.has("call-1")).toBe(true);
    expect(state.pinnedToolCallIds.has("call-2")).toBe(true);
    expect(state.pinnedToolCallIds.size).toBe(2);
  });

  test("tool pins and unpins correctly", async () => {
    const store = new InMemoryPinnedStore();
    const strategy = new PinnedMessagesStrategy({ pinnedStore: store });
    const pinTool = strategy.getOptionalTools!().pin_tool_result;

    const result1 = await pinTool.execute!(
      { pin: ["call-a", "call-b", "call-c"] },
      makeToolContext()
    );
    expect(result1).toEqual({ ok: true, pinned: ["call-a", "call-b", "call-c"] });

    const result2 = await pinTool.execute!(
      { unpin: ["call-b"] },
      makeToolContext()
    );
    expect(result2).toEqual({ ok: true, pinned: ["call-a", "call-c"] });

    const result3 = await pinTool.execute!(
      { pin: ["call-d"], unpin: ["call-a"] },
      makeToolContext()
    );
    expect(result3).toEqual({ ok: true, pinned: ["call-c", "call-d"] });
  });

  test("maxPinned limit is enforced", async () => {
    const store = new InMemoryPinnedStore();
    const strategy = new PinnedMessagesStrategy({ pinnedStore: store, maxPinned: 3 });
    const pinTool = strategy.getOptionalTools!().pin_tool_result;

    await pinTool.execute!(
      { pin: ["call-1", "call-2", "call-3"] },
      makeToolContext()
    );

    const result = await pinTool.execute!(
      { pin: ["call-4", "call-5"] },
      makeToolContext()
    );

    expect(result).toEqual({
      ok: true,
      pinned: ["call-3", "call-4", "call-5"],
    });
  });

  test("pinned IDs persist across apply() calls", async () => {
    const store = new InMemoryPinnedStore();
    const strategy = new PinnedMessagesStrategy({ pinnedStore: store });
    const pinTool = strategy.getOptionalTools!().pin_tool_result;

    await pinTool.execute!(
      { pin: ["call-x", "call-y"] },
      makeToolContext()
    );

    const state1 = makeState(makePrompt());
    await strategy.apply(state1);
    expect(state1.pinnedToolCallIds.has("call-x")).toBe(true);
    expect(state1.pinnedToolCallIds.has("call-y")).toBe(true);

    const state2 = makeState(makePrompt());
    await strategy.apply(state2);
    expect(state2.pinnedToolCallIds.has("call-x")).toBe(true);
    expect(state2.pinnedToolCallIds.has("call-y")).toBe(true);
  });
});
