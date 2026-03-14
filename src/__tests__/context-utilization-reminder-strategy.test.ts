import { ContextUtilizationReminderStrategy, createContextManagementRuntime } from "../index.js";
import type { ContextManagementTelemetryEvent } from "../index.js";
import { makePrompt } from "./helpers.js";

describe("ContextUtilizationReminderStrategy", () => {
  test("no-ops below threshold", async () => {
    const strategy = new ContextUtilizationReminderStrategy({
      workingTokenBudget: 10_000,
      warningThresholdRatio: 0.7,
      estimator: {
        estimateMessage: () => 1,
        estimatePrompt: () => 100,
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
      addRemovedToolExchanges() {},
      addPinnedToolCallIds() {},
    } as any;

    const result = strategy.apply(state);

    expect(result).toEqual({
      reason: "below-warning-threshold",
      workingTokenBudget: 10000,
      payloads: {
        currentTokens: 100,
        warningThresholdTokens: 7000,
        warningThresholdRatio: 0.7,
        mode: "generic",
      },
    });
  });

  test("injects warning at or above threshold and emits telemetry payloads through runtime", async () => {
    const events: ContextManagementTelemetryEvent[] = [];
    const runtime = createContextManagementRuntime({
      strategies: [
        new ContextUtilizationReminderStrategy({
          workingTokenBudget: 100,
          warningThresholdRatio: 0.7,
          mode: "scratchpad",
          estimator: {
            estimateMessage: () => 40,
            estimatePrompt: () => 80,
          },
        }),
      ],
      telemetry: async (event) => {
        events.push(event);
      },
      estimator: {
        estimateMessage: () => 40,
        estimatePrompt: () => 80,
      },
    });

    const prompt = makePrompt();
    const transformed = await runtime.middleware.transformParams?.({
      params: {
        prompt,
        providerOptions: {
          contextManagement: {
            conversationId: "conv-1",
            agentId: "agent-1",
          },
        },
      },
      model: {
        specificationVersion: "v3",
        provider: "mock",
        modelId: "mock",
        supportedUrls: {},
        doGenerate: async () => { throw new Error("unused"); },
        doStream: async () => { throw new Error("unused"); },
      },
    } as any);

    expect(JSON.stringify(transformed?.prompt)).toContain("Use scratchpad(...) now");

    const strategyEvent = events.find((event) => event.type === "strategy-complete");
    expect(strategyEvent).toBeDefined();
    if (strategyEvent?.type === "strategy-complete") {
      expect(strategyEvent.reason).toBe("warning-injected");
      expect(strategyEvent.workingTokenBudget).toBe(100);
      expect(strategyEvent.payloads.strategy).toEqual(
        expect.objectContaining({
          currentTokens: 80,
          warningThresholdTokens: 70,
          utilizationPercent: 80,
          mode: "scratchpad",
          reminderText: expect.stringContaining("Use scratchpad(...) now"),
        })
      );
    }
  });
});
