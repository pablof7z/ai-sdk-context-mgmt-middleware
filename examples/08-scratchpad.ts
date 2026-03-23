/**
 * Scratchpad — let the agent maintain structured working state and omit stale tool exchanges
 */
import { generateText, wrapLanguageModel, type ModelMessage } from "ai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { ScratchpadState, ScratchpadToolInput } from "ai-sdk-context-management";
import {
  ScratchpadStrategy,
  createContextManagementRuntime,
} from "ai-sdk-context-management";
import {
  DEMO_CONTEXT,
  createMockTextModel,
  createPromptCaptureMiddleware,
  printPrompt,
} from "./helpers.js";

async function main() {
  const scratchpads = new Map<string, ScratchpadState>();
  scratchpads.set("demo-conversation:planner", {
    entries: {
      objective: "Finish parser review",
      status: "API review complete, waiting on parser validation.",
    },
    omitToolCallIds: [],
    agentLabel: "Planner",
  });

  const runtime = createContextManagementRuntime({
    strategies: [
      new ScratchpadStrategy({
        scratchpadStore: {
          get: ({ conversationId, agentId }) =>
            scratchpads.get(`${conversationId}:${agentId}`),
          set: ({ conversationId, agentId }, state) => {
            scratchpads.set(`${conversationId}:${agentId}`, state);
          },
          listConversation: (conversationId) =>
            [...scratchpads.entries()]
              .filter(([key]) => key.startsWith(`${conversationId}:`))
              .map(([key, state]) => ({
                agentId: key.split(":")[1],
                agentLabel: state.agentLabel,
                state,
              })),
        },
      }),
    ],
  });

  const toolResult = await ((runtime.optionalTools.scratchpad as unknown) as {
    execute: (
      input: ScratchpadToolInput,
      options: { experimental_context: unknown }
    ) => Promise<unknown>;
  }).execute(
    {
      description: "Capture parser findings and drop stale file reads",
      setEntries: {
        finding: "Parser edge case is around trailing commas.",
        nextStep: "Re-check trailing comma handling in parser.ts.",
        notes: "Reviewer: old shell output is no longer needed.",
      },
      preserveTurns: 1,
      omitToolCallIds: ["call-old"],
    },
    {
      toolCallId: "scratchpad-demo-call-1",
      messages: [
        { role: "system", content: "You are a code review agent." },
        { role: "user", content: "Continue the parser review." },
      ],
      experimental_context: DEMO_CONTEXT,
    }
  );

  const capturedPrompts: LanguageModelV3Prompt[] = [];
  const model = wrapLanguageModel({
    model: wrapLanguageModel({
      model: createMockTextModel("I still have the notes even though the old tool output is gone."),
      middleware: createPromptCaptureMiddleware(capturedPrompts),
    }),
    middleware: runtime.middleware,
  });

  const messages: ModelMessage[] = [
    { role: "system", content: "You are a code review agent." },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-old", toolName: "read_file", input: { path: "parser.ts" } }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-old",
        toolName: "read_file",
        output: { type: "text", value: "legacy parser contents" },
      }],
    },
    { role: "user", content: "Continue the parser review." },
  ];

  const result = await generateText({
    model,
    messages,
    providerOptions: DEMO_CONTEXT,
  });

  printPrompt("Prompt after ScratchpadStrategy", capturedPrompts[0]);
  console.log("\nTool result from scratchpad(...):");
  console.log(JSON.stringify(toolResult, null, 2));
  console.log("\nWhat changed:");
  console.log("- the omitted tool exchange disappeared from the prompt");
  console.log("- the latest user message gained a scratchpad reminder block");
  console.log("- scratchpad entries, including a notes key, were injected into the reminder block");
  console.log("- other agents' scratchpads were injected with attribution");
  console.log(`\nModel output: ${result.text}`);
}

main().catch(console.error);
