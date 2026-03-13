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
});
