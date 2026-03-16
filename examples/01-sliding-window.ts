/**
 * Sliding Window — keep the recent tail, or preserve a head plus tail
 */
import { generateText, wrapLanguageModel, type ModelMessage } from "ai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  SlidingWindowStrategy,
  createContextManagementRuntime,
} from "ai-sdk-context-management";
import {
  DEMO_CONTEXT,
  createMockTextModel,
  createPromptCaptureMiddleware,
  printPrompt,
} from "./helpers.js";

async function main() {
  const runtime = createContextManagementRuntime({
    strategies: [new SlidingWindowStrategy({ keepLastMessages: 4 })],
  });

  const capturedPrompts: LanguageModelV3Prompt[] = [];
  const model = wrapLanguageModel({
    model: wrapLanguageModel({
      model: createMockTextModel("Only Germany and Italy are still visible."),
      middleware: createPromptCaptureMiddleware(capturedPrompts),
    }),
    middleware: runtime.middleware,
  });

  const messages: ModelMessage[] = [
    { role: "system", content: "You are a helpful geography assistant." },
    { role: "user", content: "What is the capital of France?" },
    { role: "assistant", content: "Paris." },
    { role: "user", content: "What about Germany?" },
    { role: "assistant", content: "Berlin." },
    { role: "user", content: "And Italy?" },
    { role: "assistant", content: "Rome." },
    { role: "user", content: "List every capital I asked about." },
  ];

  const result = await generateText({
    model,
    messages,
    providerOptions: DEMO_CONTEXT,
  });

  printPrompt("Prompt after SlidingWindowStrategy", capturedPrompts[0]);
  console.log("\nWhat changed:");
  console.log("- only the last 4 non-system messages survive");
  console.log("- the France exchange is gone before the model answers");
  console.log(`\nModel output: ${result.text}`);
}

main().catch(console.error);
