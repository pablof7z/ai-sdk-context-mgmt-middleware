import { ContextWindowStatusStrategy, createContextManagementRuntime } from "../index.js";
import type { ContextManagementTelemetryEvent } from "../index.js";
import { makePrompt } from "./helpers.js";

describe("ContextWindowStatusStrategy", () => {
  test("injects prompt status using working budget and raw model window", async () => {
    const events: ContextManagementTelemetryEvent[] = [];
    const runtime = createContextManagementRuntime({
      strategies: [
        new ContextWindowStatusStrategy({
          workingTokenBudget: 400,
          estimator: {
            estimateMessage: () => 10,
            estimatePrompt: () => 120,
          },
          getContextWindow: ({ model }) =>
            model?.provider === "openrouter" && model.modelId === "anthropic/claude-4"
              ? 200_000
              : undefined,
        }),
      ],
      telemetry: async (event) => {
        events.push(event);
      },
      estimator: {
        estimateMessage: () => 10,
        estimatePrompt: () => 120,
      },
    });

    const transformed = await runtime.middleware.transformParams?.({
      params: {
        prompt: makePrompt(),
        providerOptions: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
          },
        },
      },
      model: {
        specificationVersion: "v3",
        provider: "openrouter",
        modelId: "anthropic/claude-4",
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("unused");
        },
        doStream: async () => {
          throw new Error("unused");
        },
      },
    } as any);

    expect(JSON.stringify(transformed?.prompt)).toContain("Current prompt after context management: ~120 tokens.");
    expect(JSON.stringify(transformed?.prompt)).toContain("Working budget target: ~400 tokens (~30% used).");
    expect(JSON.stringify(transformed?.prompt)).toContain("Raw model context window: ~200,000 tokens (~0% used).");

    const strategyEvent = events.find((event) => event.type === "strategy-complete");
    expect(strategyEvent).toBeDefined();
    if (strategyEvent?.type === "strategy-complete") {
      expect(strategyEvent.reason).toBe("context-window-status-injected");
      expect(strategyEvent.payloads.strategy).toEqual(
        expect.objectContaining({
          estimatedPromptTokens: 120,
          rawContextWindow: 200_000,
          workingTokenBudget: 400,
          reminderText: expect.stringContaining("Current prompt after context management"),
        })
      );
    }
  });

  test("skips when neither working budget nor raw context window is available", () => {
    const strategy = new ContextWindowStatusStrategy({
      estimator: {
        estimateMessage: () => 10,
        estimatePrompt: () => 120,
      },
    });
    const prompt = makePrompt();
    const state = {
      params: { prompt, providerOptions: {} },
      prompt,
      requestContext: { conversationId: "conv-1", agentId: "agent-1" },
      removedToolExchanges: [],
      pinnedToolCallIds: new Set<string>(),
      updatePrompt(nextPrompt: typeof prompt) {
        this.prompt = nextPrompt;
      },
      updateParams() {},
      addRemovedToolExchanges() {},
      addPinnedToolCallIds() {},
    } as any;

    const result = strategy.apply(state);

    expect(result).toEqual({
      outcome: "skipped",
      reason: "no-context-capacity-data",
      payloads: {
        estimatedPromptTokens: 120,
      },
    });
  });
});
