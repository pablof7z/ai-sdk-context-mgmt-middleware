import type { ContextManagementTelemetryEvent } from "../index.js";
import { createContextManagementRuntime, ScratchpadStrategy, SlidingWindowStrategy } from "../index.js";
import { InMemoryScratchpadStore, makePrompt } from "./helpers.js";

describe("createContextManagementRuntime", () => {
  test("returns middleware plus merged optional tools", async () => {
    const runtime = createContextManagementRuntime({
      strategies: [
        new SlidingWindowStrategy({ keepLastMessages: 2 }),
        new ScratchpadStrategy({ scratchpadStore: new InMemoryScratchpadStore() }),
      ],
    });

    expect(typeof runtime.middleware.transformParams).toBe("function");
    expect(Object.keys(runtime.optionalTools)).toEqual(["scratchpad"]);
  });

  test("no-ops when request context is missing", async () => {
    const runtime = createContextManagementRuntime({
      strategies: [new SlidingWindowStrategy({ keepLastMessages: 1 })],
    });
    const prompt = makePrompt();
    const params = {
      prompt,
      providerOptions: undefined,
    };

    const result = await runtime.middleware.transformParams?.({
      params,
      model: { specificationVersion: "v3", provider: "mock", modelId: "mock", doGenerate: async () => { throw new Error("unused"); }, doStream: async () => { throw new Error("unused"); }, supportedUrls: {} },
    } as any);

    expect(result).toBe(params);
  });

  test("emits runtime and strategy telemetry with full prompt payloads", async () => {
    const events: ContextManagementTelemetryEvent[] = [];
    const runtime = createContextManagementRuntime({
      strategies: [new SlidingWindowStrategy({ keepLastMessages: 2 })],
      telemetry: async (event) => {
        events.push(event);
      },
    });

    const prompt = makePrompt();
    await runtime.middleware.transformParams?.({
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

    expect(events.map((event) => event.type)).toEqual([
      "runtime-start",
      "strategy-complete",
      "runtime-complete",
    ]);

    const strategyEvent = events[1];
    expect(strategyEvent.type).toBe("strategy-complete");
    if (strategyEvent.type === "strategy-complete") {
      expect(strategyEvent.strategyName).toBe("sliding-window");
      expect(strategyEvent.payloads.promptBefore).toBeDefined();
      expect(strategyEvent.payloads.promptAfter).toBeDefined();
    }
  });

  test("wraps optional tools with telemetry for execute lifecycle", async () => {
    const store = new InMemoryScratchpadStore();
    const events: ContextManagementTelemetryEvent[] = [];
    const runtime = createContextManagementRuntime({
      strategies: [new ScratchpadStrategy({ scratchpadStore: store })],
      telemetry: async (event) => {
        events.push(event);
      },
    });

    await runtime.optionalTools.scratchpad.execute?.(
      {
        notes: "Track parser cleanup",
      },
      {
        toolCallId: "scratchpad-call-1",
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

    expect(events.map((event) => event.type)).toEqual([
      "tool-execute-start",
      "tool-execute-complete",
    ]);

    const completeEvent = events[1];
    expect(completeEvent.type).toBe("tool-execute-complete");
    if (completeEvent.type === "tool-execute-complete") {
      expect(completeEvent.toolName).toBe("scratchpad");
      expect(completeEvent.requestContext).toEqual({
        conversationId: "conv-1",
        agentId: "agent-1",
        agentLabel: "Alpha",
      });
      expect(completeEvent.payloads.result).toEqual({
        ok: true,
        state: expect.objectContaining({
          notes: "Track parser cleanup",
        }),
      });
    }
  });
});
