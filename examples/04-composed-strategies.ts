/**
 * Composed Strategies — a full stack with telemetry
 */
import { generateText, wrapLanguageModel, type ModelMessage } from "ai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import {
  ContextUtilizationReminderStrategy,
  SummarizationStrategy,
  ScratchpadStrategy,
  SystemPromptCachingStrategy,
  ToolResultDecayStrategy,
  createContextManagementRuntime,
  createDefaultPromptTokenEstimator,
  type ScratchpadState,
} from "ai-sdk-context-management";
import {
  DEMO_CONTEXT,
  createMockTextModel,
  createPromptCaptureMiddleware,
  printPrompt,
} from "./helpers.js";

async function main() {
  const estimator = createDefaultPromptTokenEstimator();
  const scratchpads = new Map<string, ScratchpadState>();
  const capturedPrompts: LanguageModelV3Prompt[] = [];
  const telemetryEvents: string[] = [];

  const summarizerModel = createMockTextModel(
    "Key findings: config uses port 3000, tests create a DB, entry point starts the server."
  );

  const runtime = createContextManagementRuntime({
    strategies: [
      new SystemPromptCachingStrategy(),
      new ToolResultDecayStrategy({
        maxPromptTokens: 120,
        keepFullResultCount: 1,
        truncateWindowCount: 1,
        truncatedMaxTokens: 10,
        placeholder: "[omitted]",
        estimator,
      }),
      new SummarizationStrategy({
        model: summarizerModel,
        maxPromptTokens: 160,
        preserveRecentMessages: 4,
        estimator,
      }),
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
        reminderTone: "informational",
      }),
      new ContextUtilizationReminderStrategy({
        workingTokenBudget: 200,
        warningThresholdRatio: 0.6,
        mode: "scratchpad",
        estimator,
      }),
    ],
    estimator,
    telemetry: async (event) => {
      telemetryEvents.push(`${event.type}${"strategyName" in event ? `:${event.strategyName}` : ""}`);
    },
  });

  await ((runtime.optionalTools.scratchpad as unknown) as {
    execute: (input: unknown, options: { experimental_context: unknown }) => Promise<unknown>;
  }).execute(
    {
      setEntries: {
        notes: "Track config, test setup, and entry point.",
      },
    },
    { experimental_context: DEMO_CONTEXT }
  );

  const model = wrapLanguageModel({
    model: wrapLanguageModel({
      model: createMockTextModel("The project has a config layer, a test bootstrap, and a server entry point."),
      middleware: createPromptCaptureMiddleware(capturedPrompts),
    }),
    middleware: runtime.middleware,
  });

  const messages: ModelMessage[] = [
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: "Read config.json." },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "config.json" } }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "t1",
        toolName: "read_file",
        output: { type: "text", value: '{ "port": 3000, "host": "localhost", "debug": true }' },
      }],
    },
    { role: "assistant", content: "The config enables debug mode on port 3000." },
    { role: "user", content: "Read test/setup.ts." },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t2", toolName: "read_file", input: { path: "test/setup.ts" } }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "t2",
        toolName: "read_file",
        output: {
          type: "text",
          value:
            'beforeAll(async () => { await createTestDatabase(); }); afterAll(async () => { await cleanupTestDatabase(); });',
        },
      }],
    },
    { role: "assistant", content: "Tests create and clean up a database." },
    { role: "user", content: "Read src/index.ts." },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t3", toolName: "read_file", input: { path: "src/index.ts" } }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "t3",
        toolName: "read_file",
        output: {
          type: "text",
          value: 'const config = loadConfig(); const server = createServer(config); server.listen(config.port);',
        },
      }],
    },
    { role: "assistant", content: "The entry point loads config and starts the server." },
    { role: "user", content: "How is the project structured?" },
  ];

  const result = await generateText({
    model,
    messages,
    providerOptions: DEMO_CONTEXT,
    experimental_context: DEMO_CONTEXT,
  });

  printPrompt("Prompt after the composed stack", capturedPrompts[0]);
  console.log("\nWhat changed:");
  console.log("- system messages were normalized to the front");
  console.log("- old tool results were shortened before summarization kicked in");
  console.log("- the agent scratchpad was injected as a reminder block");
  console.log("- a utilization warning appeared once the working budget got tight");
  console.log(`\nTelemetry: ${telemetryEvents.join(", ")}`);
  console.log(`\nModel output: ${result.text}`);
}

main().catch(console.error);
