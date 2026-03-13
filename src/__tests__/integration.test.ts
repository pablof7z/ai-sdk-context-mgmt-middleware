import { simulateReadableStream, stepCountIs, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  createContextManagementRuntime,
  ScratchpadStrategy,
  SlidingWindowStrategy,
} from "../index.js";
import { InMemoryScratchpadStore, usage } from "./helpers.js";

describe("context management runtime integration", () => {
  test("scratchpad tool updates future prompt projection in streamText", async () => {
    const store = new InMemoryScratchpadStore();
    const runtime = createContextManagementRuntime({
      strategies: [
        new SlidingWindowStrategy({ keepLastMessages: 4 }),
        new ScratchpadStrategy({ scratchpadStore: store }),
      ],
    });

    let callCount = 0;
    const baseModel = new MockLanguageModelV3({
      doStream: async () => {
        callCount += 1;

        if (callCount === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "tool-call",
                  toolCallId: "scratchpad-call-1",
                  toolName: "scratchpad",
                  input: JSON.stringify({
                    notes: "Track parser follow-up",
                    omitToolCallIds: ["call-old"],
                  }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage: usage(),
                },
              ],
            }),
          };
        }

        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "done" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(),
              },
            ],
          }),
        };
      },
    });

    const wrappedModel = wrapLanguageModel({
      model: baseModel,
      middleware: runtime.middleware,
    });

    const result = streamText({
      model: wrappedModel,
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call-old", toolName: "fs_read", input: { path: "old.ts" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call-old", toolName: "fs_read", output: { type: "text", value: "old contents" } }],
        },
        { role: "user", content: "Continue." },
      ],
      tools: runtime.optionalTools,
      stopWhen: stepCountIs(2),
      providerOptions: {
        contextManagement: {
          conversationId: "conv-1",
          agentId: "agent-1",
          agentLabel: "Alpha",
        },
      },
      experimental_context: {
        contextManagement: {
          conversationId: "conv-1",
          agentId: "agent-1",
          agentLabel: "Alpha",
        },
      },
    });

    expect(await result.text).toBe("done");
    expect(await store.get({ conversationId: "conv-1", agentId: "agent-1" })).toEqual(
      expect.objectContaining({
        notes: "Track parser follow-up",
        omitToolCallIds: ["call-old"],
      })
    );
    expect(baseModel.doStreamCalls).toHaveLength(2);
    const secondPrompt = baseModel.doStreamCalls[1].prompt;
    expect(
      secondPrompt.some((message: any) =>
        message.content?.some?.((part: any) =>
          (part.type === "tool-call" || part.type === "tool-result") && part.toolCallId === "call-old"
        )
      )
    ).toBe(false);
    expect(JSON.stringify(secondPrompt)).toContain("Track parser follow-up");
  });
});
