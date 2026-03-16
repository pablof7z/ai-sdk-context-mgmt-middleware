/**
 * Model-Backed Summarization — use SummarizationStrategy with a built-in model-backed summarizer
 */
import { generateText, wrapLanguageModel, type ModelMessage } from "ai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
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

async function main() {
  const runtime = createContextManagementRuntime({
    strategies: [
      new SummarizationStrategy({
        model: createMockTextModel(
          "Key findings: parser handles JSON and YAML, but edge cases remain around trailing commas."
        ),
        maxPromptTokens: 40,
        preserveRecentMessages: 2,
      }),
    ],
  });

  const capturedPrompts: LanguageModelV3Prompt[] = [];
  const model = wrapLanguageModel({
    model: wrapLanguageModel({
      model: createMockTextModel("The LLM-produced summary preserved the older parser discussion."),
      middleware: createPromptCaptureMiddleware(capturedPrompts),
    }),
    middleware: runtime.middleware,
  });

  const messages: ModelMessage[] = [
    { role: "system", content: "You are debugging a parser migration." },
    { role: "user", content: "We support JSON today." },
    { role: "assistant", content: "Understood." },
    { role: "user", content: "We also need YAML before release." },
    { role: "assistant", content: "I will track both formats." },
    { role: "user", content: "What is still risky?" },
  ];

  const result = await generateText({
    model,
    messages,
    providerOptions: DEMO_CONTEXT,
  });

  printPrompt("Prompt after model-backed SummarizationStrategy", capturedPrompts[0]);
  console.log("\nWhat changed:");
  console.log("- older turns were replaced by a model-generated summary");
  console.log("- the latest question stayed raw");
  console.log("- the agent keeps salient facts without replaying the whole transcript");
  console.log(`\nModel output: ${result.text}`);
}

main().catch(console.error);
