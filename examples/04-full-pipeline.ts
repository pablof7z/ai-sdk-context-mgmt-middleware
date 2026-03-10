/**
 * Example 04: Full Pipeline with Caching
 * 
 * Complete production-like setup with all features:
 * - Tool output policies with per-tool configuration
 * - LLM-assisted compression (tier 2)
 * - Compression caching
 * - Debug output
 * - Truncation hook for external storage
 * 
 * Requires: OPENAI_API_KEY environment variable (or runs with mock)
 */
import {
  contextManagement,
  createLLMCompressor,
  createCompressionCache,
} from "ai-sdk-context-mgmt-middleware";
import { generateConversation, generateToolExchange } from "./helpers.js";

async function main() {
  console.log("=== Example 04: Full Pipeline with Caching ===\n");

  // Simulate external storage
  const externalStore = new Map<string, string>();

  // Set up caching
  const cache = createCompressionCache(50);

  // Mock LLM compressor (replace with real one using OPENAI_API_KEY)
  const llmCompressor = {
    compress: async (messages: any[], targetTokens: number) => {
      console.log(`  [LLM] Summarizing ${messages.length} messages into ~${targetTokens} tokens...`);
      return [{
        role: "assistant" as const,
        content: `[Summary: ${messages.length} earlier messages covered project setup, debugging, and feature planning.]`,
      }];
    },
  };

  const middleware = contextManagement({
    maxTokens: 3_000,
    ruleBasedThreshold: 0.7,
    llmThreshold: 0.85,
    protectedTailCount: 4,

    toolOutputPolicy: {
      defaultPolicy: "truncate",
      maxOutputTokens: 100,
      perTool: {
        file_read: { policy: "truncate", maxTokens: 200 },
        search: { policy: "truncate", maxTokens: 50 },
        logs: { policy: "remove" },
        calculate: { policy: "keep" },
      },
    },

    llmCompressor,
    cache,

    onToolOutputTruncated: async (event) => {
      // Store original output
      const id = `stored_${Date.now()}_${event.toolName}`;
      externalStore.set(id, event.originalOutput);
      console.log(`  [store] Saved ${event.toolName} output as ${id} (${event.originalTokens} tokens)`);

      if (event.removed) {
        return `[Output stored externally. ID: ${id}]`;
      }
      return undefined; // Use default truncation
    },

    onDebug: (info) => {
      const saved = info.originalTokenEstimate - info.compressedTokenEstimate;
      console.log(`\n[debug] === Compression Report ===`);
      console.log(`[debug] Tier: ${info.tier}`);
      console.log(`[debug] Tokens: ${info.originalTokenEstimate} → ${info.compressedTokenEstimate}`);
      console.log(`[debug] Saved: ${saved} tokens`);
      console.log(`[debug] Cached: ${info.cacheHit}`);
      console.log(`[debug] Modifications:`);
      for (const mod of info.modifications) {
        console.log(
          `[debug]   ${mod.type}: ${mod.toolName || "message"} ` +
          `(${mod.originalTokens} → ${mod.compressedTokens} tokens)`
        );
      }
    },
  });

  // Build a realistic conversation
  const messages = [
    ...generateConversation(5),
    ...generateToolExchange("file_read", 400),
    ...generateConversation(3),
    ...generateToolExchange("search", 300),
    ...generateToolExchange("logs", 500),
    ...generateConversation(4),
    ...generateToolExchange("calculate", 50),
    ...generateConversation(2),
  ];

  console.log(`Input: ${messages.length} messages`);

  if (middleware.transformParams) {
    // First call - no cache
    console.log("\n--- First call (no cache) ---");
    const result1 = await middleware.transformParams({
      type: "generate",
      params: {
        prompt: messages,
        mode: { type: "regular" },
        inputFormat: "messages",
      },
    } as any);
    console.log(`\nOutput: ${result1.prompt.length} messages`);

    // Second call with same messages - should hit cache
    console.log("\n--- Second call (cache hit expected) ---");
    const result2 = await middleware.transformParams({
      type: "generate",
      params: {
        prompt: messages,
        mode: { type: "regular" },
        inputFormat: "messages",
      },
    } as any);
    console.log(`\nOutput: ${result2.prompt.length} messages`);

    // Show external store contents
    console.log(`\n--- External Store ---`);
    console.log(`Stored ${externalStore.size} tool outputs:`);
    for (const [id, content] of externalStore) {
      console.log(`  ${id}: ${content.length} chars`);
    }
  }
}

main().catch(console.error);
