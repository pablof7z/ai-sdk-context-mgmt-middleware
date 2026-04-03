/**
 * Compaction Tool — let the agent request compaction explicitly
 */
import type { ModelMessage } from "ai";
import {
  CompactionToolStrategy,
  createContextManagementRuntime,
  type CompactionState,
} from "ai-sdk-context-management";
import {
  DEMO_CONTEXT,
  printPrompt,
  runPreparedDemo,
} from "./helpers.js";

async function main() {
  const messages: ModelMessage[] = [
    { role: "system", content: "You are analyzing a TypeScript service.", id: "system-1" },
    {
      role: "user",
      id: "msg-user-1",
      eventId: "evt-user-1",
      content: "Read config.json.",
    },
    {
      role: "assistant",
      id: "msg-assistant-1",
      eventId: "evt-assistant-1",
      content: "Port 3000, localhost, debug enabled.",
    },
    {
      role: "user",
      id: "msg-user-2",
      eventId: "evt-user-2",
      content: "Read test/setup.ts.",
    },
    {
      role: "assistant",
      id: "msg-assistant-2",
      eventId: "evt-assistant-2",
      content: "Tests create and clean up a database.",
    },
    {
      role: "user",
      id: "msg-user-3",
      eventId: "evt-user-3",
      content: "What should we fix next?",
    },
  ];
  const compactions = new Map<string, CompactionState>();
  const runtime = createContextManagementRuntime({
    strategies: [
      new CompactionToolStrategy({
        compactionStore: {
          get: ({ conversationId, agentId }) =>
            compactions.get(`${conversationId}:${agentId}`),
          set: ({ conversationId, agentId }, state) => {
            compactions.set(`${conversationId}:${agentId}`, state);
          },
        },
        onCompact: async ({ steeringMessage }) =>
          steeringMessage
            ? `Host summary:\n${steeringMessage}`
            : "Host summary:\nTask: inspect service config and tests.\nCompleted: config uses port 3000 and tests bootstrap a DB.",
      }),
    ],
  });

  const toolResult = await ((runtime.optionalTools.compact_context as unknown) as {
    execute: (
      input: {
        guidance?: string;
        from?: string;
        to?: string;
      },
      options: { messages: ModelMessage[]; experimental_context: unknown }
    ) => Promise<unknown>;
  }).execute(
    {
      guidance:
        "Task: inspect service config and tests.\nCompleted: config uses port 3000 and tests bootstrap a DB.\nImportant Findings: parser issue remains around trailing commas.\nOpen Issues: fix parser handling.\nNext Steps: patch the parser and rerun tests.\nPersistent Facts: keep localhost/debug details in mind.",
      from: "Read config.json.",
      to: "Tests create and clean up a database.",
    },
    {
      messages,
      experimental_context: DEMO_CONTEXT,
    }
  );

  const firstRun = await runPreparedDemo({
    runtime,
    messages,
    responseText: "The compacted summary is enough to continue.",
  });

  const secondRun = await runPreparedDemo({
    runtime,
    messages: [
      { role: "system", content: "You are analyzing a TypeScript service." },
      { role: "user", content: "Continue from the previous investigation." },
    ],
    responseText: "The compacted summary is enough to continue.",
  });

  printPrompt("Prompt on the compaction turn", firstRun.capturedPrompts[0]);
  printPrompt("Prompt on the following turn", secondRun.capturedPrompts[0]);
  console.log("\nTool result from compact_context(...):");
  console.log(JSON.stringify(toolResult, null, 2));
  console.log("\nWhat changed:");
  console.log("- compact_context(...) queued an anchored host-driven compaction over the older user/assistant span");
  console.log("- the first call replaced that span with the host-generated continuation summary");
  console.log("- the second call re-applied the stored compaction before the new request");
}

main().catch(console.error);
