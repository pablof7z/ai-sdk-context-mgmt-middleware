/**
 * Example 02: Tool Output Policies
 * 
 * Shows per-tool output policies (keep, truncate, remove) and the
 * onToolOutputTruncated hook for external storage integration.
 */
import { contextManagement } from "ai-sdk-context-mgmt-middleware";
import { generateConversation, generateToolExchange, generatePadding } from "./helpers.js";

async function main() {
  console.log("=== Example 02: Tool Output Policies ===\n");

  const truncatedOutputs: Array<{ toolName: string; size: number; removed: boolean }> = [];

  const middleware = contextManagement({
    // Intentionally low to trigger compression
    maxTokens: 4_000,
    ruleBasedThreshold: 0.7,
    protectedTailCount: 2,

    toolOutput: {
      defaultPolicy: "truncate",
      maxTokens: 50,
      toolOverrides: {
        search_results: "truncate",
        debug_logs: "remove",
        important_data: "keep",
      },
    },

    // Hook: track what gets truncated
    onToolOutputTruncated: async (event) => {
      truncatedOutputs.push({
        toolName: event.toolName,
        size: event.originalTokens,
        removed: event.removed,
      });
      console.log(
        `  [hook] ${event.removed ? "REMOVED" : "TRUNCATED"}: ${event.toolName} ` +
        `(${event.originalTokens} tokens)`
      );

      // Optionally return replacement text
      if (event.removed) {
        return `[Output was ${event.originalTokens} tokens. Use retrieve_tool_output("${event.toolCallId}") to fetch.]`;
      }
      // Return undefined to keep default truncation
      return undefined;
    },

    onDebug: (info) => {
      const saved = info.originalTokenEstimate - info.compressedTokenEstimate;
      console.log(`\n[debug] Tier: ${info.tier}`);
      console.log(`[debug] Tokens: ${info.originalTokenEstimate} → ${info.compressedTokenEstimate} (saved ${saved})`);
      for (const mod of info.modifications) {
        console.log(`[debug]   ${mod.type}: ${mod.toolName || "message"} at index ${mod.messageIndex}`);
      }
    },
  });

  // Build a conversation with various tool outputs
  const messages = [
    ...generateConversation(3),
    ...generateToolExchange("search_results", 500),
    ...generateConversation(2),
    ...generateToolExchange("debug_logs", 300),
    ...generateConversation(1),
    ...generateToolExchange("important_data", 200),
    ...generateConversation(1),
  ];

  console.log(`Input: ${messages.length} messages\n`);

  if (middleware.transformParams) {
    const result = await middleware.transformParams({
      type: "generate",
      params: {
        prompt: messages,
        mode: { type: "regular" },
        inputFormat: "messages",
      },
    } as any);

    console.log(`\nOutput: ${result.prompt.length} messages`);
    console.log(`\nTruncation events: ${truncatedOutputs.length}`);
    for (const t of truncatedOutputs) {
      console.log(`  - ${t.toolName}: ${t.removed ? "removed" : "truncated"} (was ${t.size} tokens)`);
    }
  }
}

main().catch(console.error);
