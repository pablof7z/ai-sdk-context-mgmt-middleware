import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { SystemPromptCachingStrategy } from "../system-prompt-caching-strategy.js";

describe("SystemPromptCachingStrategy", () => {
  function makeState(prompt: LanguageModelV3Prompt) {
    return {
      prompt,
      pinnedToolCallIds: new Set<string>(),
      removedToolExchanges: [],
      requestContext: { conversationId: "c", agentId: "a" },
      params: { prompt, providerOptions: {} },
      updatePrompt(p: LanguageModelV3Prompt) {
        this.prompt = p;
      },
      updateParams() {},
      addRemovedToolExchanges() {},
      addPinnedToolCallIds() {},
    };
  }

  test("system messages move to the front", () => {
    const strategy = new SystemPromptCachingStrategy();
    const state = makeState([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: "You are helpful." },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);

    strategy.apply(state as any);

    expect(state.prompt[0].role).toBe("system");
    expect(state.prompt[1].role).toBe("user");
    expect(state.prompt[2].role).toBe("assistant");
  });

  test("multiple system messages are consolidated into one by default", () => {
    const strategy = new SystemPromptCachingStrategy();
    const state = makeState([
      { role: "system", content: "First instruction." },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: "Second instruction." },
    ]);

    strategy.apply(state as any);

    const systemMessages = state.prompt.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toBe(
      "First instruction.\n\nSecond instruction."
    );
    expect(state.prompt.map((m) => m.role)).toEqual(["system", "user"]);
  });

  test("context-management system messages stay separate when consolidating", () => {
    const strategy = new SystemPromptCachingStrategy();
    const state = makeState([
      { role: "system", content: "Base instruction." },
      {
        role: "system",
        content: "summary text",
        providerOptions: { contextManagement: { type: "summary" } },
      },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: "Secondary instruction." },
    ]);

    strategy.apply(state as any);

    const systemMessages = state.prompt.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[0].content).toBe("Base instruction.\n\nSecondary instruction.");
    expect(systemMessages[1].content).toBe("summary text");
    expect(systemMessages[1].providerOptions).toEqual({
      contextManagement: { type: "summary" },
    });
  });

  test("with consolidateSystemMessages=false, system messages stay separate but at front", () => {
    const strategy = new SystemPromptCachingStrategy({
      consolidateSystemMessages: false,
    });
    const state = makeState([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: "First instruction." },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: "Second instruction." },
    ]);

    strategy.apply(state as any);

    expect(state.prompt.map((m) => m.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
    ]);
    expect(state.prompt[0].content).toBe("First instruction.");
    expect(state.prompt[1].content).toBe("Second instruction.");
  });

  test("non-system message order is preserved", () => {
    const strategy = new SystemPromptCachingStrategy();
    const state = makeState([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "system", content: "system" },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
      { role: "user", content: [{ type: "text", text: "third" }] },
    ]);

    strategy.apply(state as any);

    const nonSystem = state.prompt.filter((m) => m.role !== "system");
    expect(nonSystem).toHaveLength(3);
    expect((nonSystem[0].content as any)[0].text).toBe("first");
    expect((nonSystem[1].content as any)[0].text).toBe("second");
    expect((nonSystem[2].content as any)[0].text).toBe("third");
  });

  test("no-op when system messages are already at the front", () => {
    const strategy = new SystemPromptCachingStrategy({
      consolidateSystemMessages: false,
    });
    const originalPrompt: LanguageModelV3Prompt = [
      { role: "system", content: "instruction" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const state = makeState(originalPrompt);

    strategy.apply(state as any);

    expect(state.prompt.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(state.prompt[0].content).toBe("instruction");
  });
});
