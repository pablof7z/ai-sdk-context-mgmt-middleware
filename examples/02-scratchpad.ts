import { simulateReadableStream, stepCountIs, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  createContextManagementRuntime,
  ScratchpadStrategy,
  SlidingWindowStrategy,
} from "ai-sdk-context-management";
import { ExampleScratchpadStore, printPrompt, usage } from "./helpers.js";

async function main() {
  const scratchpadStore = new ExampleScratchpadStore();
  const runtime = createContextManagementRuntime({
    strategies: [
      new SlidingWindowStrategy({ keepLastMessages: 4 }),
      new ScratchpadStrategy({ scratchpadStore }),
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
                  notes: "Remember the parser follow-up",
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

  const model = wrapLanguageModel({
    model: baseModel,
    middleware: runtime.middleware,
  });

  const result = streamText({
    model,
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

  await result.text;

  console.log("\nstored scratchpad state");
  console.log(await scratchpadStore.get({ conversationId: "conv-1", agentId: "agent-1" }));
  printPrompt("provider prompt for the second step", baseModel.doStreamCalls[1].prompt);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
