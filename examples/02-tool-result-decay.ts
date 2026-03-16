/**
 * Tool Result Decay — keep reasoning, compress older tool payloads
 */
import { generateText, wrapLanguageModel, type ModelMessage } from "ai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  ToolResultDecayStrategy,
  createContextManagementRuntime,
} from "ai-sdk-context-management";
import {
  DEMO_CONTEXT,
  createMockTextModel,
  createPromptCaptureMiddleware,
  printPrompt,
} from "./helpers.js";

const LOOKUPS = [
  {
    id: "c1",
    query: "Rust ownership",
    result:
      "Rust's ownership system gives each value exactly one owner and drops the value when that owner leaves scope. ".repeat(12),
  },
  {
    id: "c2",
    query: "Rust lifetimes",
    result:
      "Lifetimes tell the compiler how long references stay valid and prevent dangling references. ".repeat(12),
  },
  {
    id: "c3",
    query: "Rust traits",
    result:
      "Traits define shared behavior and support default implementations plus generic bounds. ".repeat(12),
  },
  {
    id: "c4",
    query: "Rust async",
    result:
      "Rust async compiles futures into state machines and executors poll them to completion. ".repeat(12),
  },
  {
    id: "c5",
    query: "Rust error handling",
    result:
      "Rust uses Result<T, E> for recoverable errors and the ? operator to propagate them ergonomically. ".repeat(12),
  },
];

async function main() {
  const runtime = createContextManagementRuntime({
    strategies: [
      new ToolResultDecayStrategy({
        truncatedMaxTokens: 60,
        placeholderFloorTokens: 12,
        pressureAnchors: [
          { toolTokens: 100, depthFactor: 1 },
          { toolTokens: 1_000, depthFactor: 2.5 },
        ],
        warningForecastExtraTokens: 2_000,
        placeholder: ({ toolName, toolCallId, action }) =>
          action === "placeholder"
            ? `[${toolName} ${toolCallId} omitted -- re-read with your original tool if needed]`
            : `[truncated ${toolName} ${toolCallId}]\n`,
      }),
    ],
  });

  const capturedPrompts: LanguageModelV3Prompt[] = [];
  const model = wrapLanguageModel({
    model: wrapLanguageModel({
      model: createMockTextModel("I can only quote the newest lookup in full."),
      middleware: createPromptCaptureMiddleware(capturedPrompts),
    }),
    middleware: runtime.middleware,
  });

  const messages: ModelMessage[] = [
    { role: "system", content: "You are a Rust programming expert." },
    { role: "user", content: "Look up the core Rust concepts, then summarize them." },
  ];

  for (const lookup of LOOKUPS) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: lookup.id,
          toolName: "lookup",
          input: { query: lookup.query },
        },
      ],
    });
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: lookup.id,
          toolName: "lookup",
          output: { type: "text", value: lookup.result },
        },
      ],
    });
  }

  messages.push({ role: "user", content: "What matters most?" });

  const result = await generateText({
    model,
    messages,
    providerOptions: DEMO_CONTEXT,
  });

  printPrompt("Prompt after ToolResultDecayStrategy", capturedPrompts[0]);
  console.log("\nWhat changed:");
  console.log("- the newest tool result stays full");
  console.log("- the middle results are truncated with a header");
  console.log("- the oldest results become re-read placeholders");
  console.log("- tool calls still remain, so the reasoning chain survives");
  console.log(`\nModel output: ${result.text}`);
}

main().catch(console.error);
