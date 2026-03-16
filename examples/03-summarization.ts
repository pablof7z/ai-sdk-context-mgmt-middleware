/**
 * Summarization — replace older history with a deterministic summary block
 */
import { generateText, wrapLanguageModel, type ModelMessage } from "ai";
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  SummarizationStrategy,
  createContextManagementRuntime,
} from "ai-sdk-context-management";
import {
  DEMO_CONTEXT,
  createMockTextModel,
  createPromptCaptureMiddleware,
  printPrompt,
} from "./helpers.js";

function summarize(messages: LanguageModelV3Message[]): Promise<string> {
  const topics = messages
    .map((message) => {
      if (message.role === "system") {
        return null;
      }

      return message.content
        .map((part) => (part.type === "text" ? part.text : null))
        .filter((part): part is string => typeof part === "string")
        .join(" ");
    })
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .slice(0, 3)
    .join(" | ");

  return Promise.resolve(`Summary of older context: ${topics}`);
}

async function main() {
  const runtime = createContextManagementRuntime({
    strategies: [
      new SummarizationStrategy({
        summarize,
        maxPromptTokens: 80,
        preserveRecentMessages: 2,
      }),
    ],
  });

  const capturedPrompts: LanguageModelV3Prompt[] = [];
  const model = wrapLanguageModel({
    model: wrapLanguageModel({
      model: createMockTextModel("The summary preserved the older science facts."),
      middleware: createPromptCaptureMiddleware(capturedPrompts),
    }),
    middleware: runtime.middleware,
  });

  const messages: ModelMessage[] = [
    { role: "system", content: "You are a science tutor." },
    { role: "user", content: "What is photosynthesis?" },
    { role: "assistant", content: "Plants convert light, water, and carbon dioxide into sugars and oxygen." },
    { role: "user", content: "How does cellular respiration relate to it?" },
    { role: "assistant", content: "Cells break down sugars to release stored energy." },
    { role: "user", content: "Explain the overall energy cycle." },
  ];

  const result = await generateText({
    model,
    messages,
    providerOptions: DEMO_CONTEXT,
  });

  printPrompt("Prompt after SummarizationStrategy", capturedPrompts[0]);
  console.log("\nWhat changed:");
  console.log("- older turns were replaced by a tagged system summary");
  console.log("- the recent tail stayed verbatim while the older middle was summarized");
  console.log("- the agent can still refer to the old discussion, but through compressed facts");
  console.log(`\nModel output: ${result.text}`);
}

main().catch(console.error);
