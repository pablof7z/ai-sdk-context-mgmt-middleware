/**
 * Example 02: Always-on tool policy.
 *
 * Demonstrates that tool-call and tool-result compression runs even when the
 * conversation is still below the segment-compression threshold.
 */
import { createContextManagementMiddleware } from "ai-sdk-context-mgmt-middleware";
import { generateConversation, generateToolExchange, getTextContent, printPrompt, runMiddlewareTransform } from "./helpers.js";

async function main() {
  console.log("=== Example 02: Tool policy ===\n");

  const truncatedEntries: Array<{ toolName: string; entryType: string; removed: boolean; originalTokens: number }> = [];

  const middleware = createContextManagementMiddleware({
    maxTokens: 20_000,
    compressionThreshold: 0.95,
    toolPolicy: ({ toolName, call, result }) => ({
      call: toolName === "debug_logs"
        ? { policy: "remove" }
        : (call && call.tokens > 60 ? { policy: "truncate", maxTokens: 24 } : undefined),
      result: toolName === "important_data"
        ? { policy: "keep" }
        : toolName === "debug_logs"
          ? { policy: "remove" }
          : (result && result.tokens > 100 ? { policy: "truncate", maxTokens: 40 } : undefined),
    }),
    onToolContentTruncated: async (event) => {
      truncatedEntries.push({
        toolName: event.toolName,
        entryType: event.entryType,
        removed: event.removed,
        originalTokens: event.originalTokens,
      });

      if (event.removed) {
        return `[Content stored externally for ${event.entryType}:${event.toolName}:${event.toolCallId}]`;
      }

      return undefined;
    },
    onDebug: (info) => {
      console.log(
        `[debug] tokens ${info.originalTokenEstimate} -> ${info.compressedTokenEstimate}, ` +
        `modifications=${info.modifications.length}`
      );
    },
  });

  const prompt = [
    ...generateConversation(2),
    ...generateToolExchange("search_results", 250),
    ...generateToolExchange("debug_logs", 180),
    ...generateToolExchange("important_data", 120),
    ...generateConversation(1),
  ];

  printPrompt("input", prompt);
  const output = await runMiddlewareTransform(middleware, prompt);
  printPrompt("output", output);

  console.log("\ntruncation events:");
  for (const event of truncatedEntries) {
    console.log(
      `  ${event.toolName}/${event.entryType}: ${event.removed ? "removed" : "truncated"} ` +
      `(${event.originalTokens} tokens)`
    );
  }

  console.log("\nfinal tool messages:");
  for (const message of output.filter((message) => message.role === "assistant" || message.role === "tool")) {
    if (message.role === "assistant" || message.role === "tool") {
      console.log(`  ${message.role}: ${getTextContent(message).slice(0, 120)}${getTextContent(message).length > 120 ? "..." : ""}`);
    }
  }
}

main().catch(console.error);
