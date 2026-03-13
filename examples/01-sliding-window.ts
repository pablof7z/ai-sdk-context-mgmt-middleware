import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createContextManagementRuntime, SlidingWindowStrategy } from "ai-sdk-context-management";
import { printPrompt, usage } from "./helpers.js";

async function main() {
  const baseModel = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "done" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }),
  });

  const runtime = createContextManagementRuntime({
    strategies: [new SlidingWindowStrategy({ keepLastMessages: 2 })],
  });

  const model = wrapLanguageModel({
    model: baseModel,
    middleware: runtime.middleware,
  });

  await generateText({
    model,
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "old user" },
      { role: "assistant", content: "old assistant" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "fs_read", input: { path: "a.ts" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", toolName: "fs_read", output: { type: "text", value: "contents" } }],
      },
      { role: "user", content: "latest user" },
    ],
    providerOptions: {
      contextManagement: {
        conversationId: "conv-1",
        agentId: "agent-1",
      },
    },
  });

  printPrompt("provider prompt after sliding window", baseModel.doGenerateCalls[0].prompt);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
