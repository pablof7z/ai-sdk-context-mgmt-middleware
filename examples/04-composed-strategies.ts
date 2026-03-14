/**
 * Composed Strategies — Graduated context management with telemetry
 *
 * Combines SystemPromptCaching + ToolResultDecay + Summarization +
 * Scratchpad + ContextUtilizationReminder to show a graduated stack.
 *
 * Requires: ollama running locally with qwen2.5:3b pulled
 */
import { generateText, wrapLanguageModel, type ModelMessage } from "ai";
import type { LanguageModelV3Middleware, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { ollama } from "ollama-ai-provider-v2";
import {
  ContextUtilizationReminderStrategy,
  ScratchpadStrategy,
  SummarizationStrategy,
  createDefaultPromptTokenEstimator,
  createContextManagementRuntime,
  SystemPromptCachingStrategy,
  ToolResultDecayStrategy,
} from "ai-sdk-context-management";
import { printPrompt } from "./helpers.js";

const CONTEXT_OPTIONS = {
  contextManagement: { conversationId: "demo", agentId: "demo" },
};

async function main() {
  const scratchpads = new Map<string, any>();
  const estimator = createDefaultPromptTokenEstimator();
  const runtime = createContextManagementRuntime({
    strategies: [
      new SystemPromptCachingStrategy({ consolidateSystemMessages: true }),
      new ToolResultDecayStrategy({
        maxPromptTokens: 300,
        keepFullResultCount: 1,
        truncateWindowCount: 1,
        truncatedMaxTokens: 25,
        placeholder: "[omitted]",
        estimator,
      }),
      new SummarizationStrategy({
        summarize: async (messages) => `Summary of ${messages.length} older messages`,
        maxPromptTokens: 420,
        keepLastMessages: 6,
        estimator,
      }),
      new ScratchpadStrategy({
        scratchpadStore: {
          get: ({ conversationId, agentId }) => scratchpads.get(`${conversationId}:${agentId}`),
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
        workingTokenBudget: 500,
        warningThresholdRatio: 0.7,
        mode: "scratchpad",
        estimator,
      }),
    ],
    estimator,
    telemetry: async (event) => {
      console.log(`[telemetry:${event.type}]`, JSON.stringify(event, null, 2));
    },
  });

  // Capture transformed prompt
  const capturedPrompts: LanguageModelV3Prompt[] = [];
  const logging: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      capturedPrompts.push([...params.prompt]);
      return params;
    },
  };

  const base = ollama("qwen2.5:3b");
  const logged = wrapLanguageModel({ model: base, middleware: logging });
  const model = wrapLanguageModel({ model: logged, middleware: runtime.middleware });

  // Build a multi-turn agent conversation with tool calls and regular messages
  const messages: ModelMessage[] = [
    { role: "system", content: "You are a coding assistant with file reading capabilities." },
    // Turn 1: user asks, agent reads a file
    { role: "user", content: "What does the main config file look like?" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "config.json" } }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result", toolCallId: "t1", toolName: "read_file",
        output: { type: "text", value: '{ "port": 3000, "host": "localhost", "debug": true, "database": { "url": "postgres://localhost:5432/app", "pool": 10 } }' },
      }],
    },
    { role: "assistant", content: "The config sets port 3000, localhost, debug mode, and a postgres database." },
    // Turn 2: another file read
    { role: "user", content: "Show me the test setup." },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t2", toolName: "read_file", input: { path: "test/setup.ts" } }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result", toolCallId: "t2", toolName: "read_file",
        output: { type: "text", value: 'import { beforeAll, afterAll } from "vitest";\nimport { createTestDatabase } from "./helpers";\n\nbeforeAll(async () => {\n  await createTestDatabase();\n});\n\nafterAll(async () => {\n  await cleanupTestDatabase();\n});' },
      }],
    },
    { role: "assistant", content: "The test setup creates and tears down a test database using vitest hooks." },
    // Turn 3: yet another file
    { role: "user", content: "And the main entry point?" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t3", toolName: "read_file", input: { path: "src/index.ts" } }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result", toolCallId: "t3", toolName: "read_file",
        output: { type: "text", value: 'import { createServer } from "./server";\nimport { loadConfig } from "./config";\n\nconst config = loadConfig();\nconst server = createServer(config);\nserver.listen(config.port, () => console.log(`Running on ${config.port}`));' },
      }],
    },
    { role: "assistant", content: "The entry point loads config and starts the server." },
    // Turn 4: question about what was read
    { role: "user", content: "Based on everything you've read, how is the project structured?" },
  ];

  console.log(`=== Full conversation: ${messages.length} messages (3 tool exchanges) ===`);
  console.log("Pipeline: SystemPromptCaching -> ToolResultDecay -> Summarization -> Scratchpad -> UtilizationWarning\n");

  const result = await generateText({
    model,
    messages,
    providerOptions: CONTEXT_OPTIONS,
  });

  printPrompt("What the model received after all 3 strategies", capturedPrompts[0]);

  console.log("\n=== Strategy effects ===");
  console.log("1. SystemPromptCaching: system messages consolidated into one for cache efficiency");
  console.log("2. ToolResultDecay: older tool results are compressed before bigger fallbacks kick in");
  console.log("3. Summarization: only used if the prompt is still too large after decay");
  console.log("4. Scratchpad: always renders agent notes / omitted exchanges");
  console.log("5. UtilizationWarning: warns when the working budget is getting tight");

  console.log(`\n=== Model's response ===`);
  console.log(result.text);
}

main().catch(console.error);
