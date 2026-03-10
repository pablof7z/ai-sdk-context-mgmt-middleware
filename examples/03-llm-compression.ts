/**
 * Example 03: LLM-Assisted Compression
 * 
 * Demonstrates Tier-2 LLM-assisted compression using gpt-4o-mini.
 * When rule-based compression isn't enough, the middleware uses an LLM
 * to summarize older conversation segments.
 * 
 * Requires: OPENAI_API_KEY environment variable
 */
import { contextManagement, createLLMCompressor } from "ai-sdk-context-mgmt-middleware";
import { openai } from "@ai-sdk/openai";
import { generateConversation } from "./helpers.js";

async function main() {
  console.log("=== Example 03: LLM-Assisted Compression ===\n");

  if (!process.env.OPENAI_API_KEY) {
    console.log("⚠️  Set OPENAI_API_KEY to run this example with real LLM compression.");
    console.log("   Running with mock compressor instead.\n");
  }

  // Create LLM compressor - uses a cheap model for summarization
  const llmCompressor = process.env.OPENAI_API_KEY
    ? createLLMCompressor({
        model: openai("gpt-4o-mini"),
        maxSummaryTokens: 200,
      })
    : {
        // Mock compressor for testing without API key
        compress: async (messages: any[], targetTokens: number) => {
          console.log(`  [mock LLM] Would summarize ${messages.length} messages into ~${targetTokens} tokens`);
          return [{
            role: "assistant" as const,
            content: `[Summary of ${messages.length} earlier messages: The user and assistant discussed various topics including greetings, weather, and plans.]`,
          }];
        },
      };

  const middleware = contextManagement({
    // Very tight limit to force both tiers to activate
    maxTokens: 2_000,
    ruleBasedThreshold: 0.6,
    llmThreshold: 0.7,
    protectedTailCount: 4,
    llmCompressor,

    onDebug: (info) => {
      const saved = info.originalTokenEstimate - info.compressedTokenEstimate;
      console.log(`[debug] Tier: ${info.tier}`);
      console.log(`[debug] Tokens: ${info.originalTokenEstimate} → ${info.compressedTokenEstimate}`);
      console.log(`[debug] Savings: ${saved} tokens (${info.originalTokenEstimate > 0 ? ((saved / info.originalTokenEstimate) * 100).toFixed(1) : 0}%)`);
      if (info.tier === "llm-assisted") {
        console.log(`[debug] LLM compression was used to summarize older messages`);
      }
    },
  });

  // Generate a long conversation that will need LLM compression
  const messages = generateConversation(20);
  console.log(`Input: ${messages.length} messages (${20} turns)\n`);

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

    // Show the first message (likely a summary)
    const firstMsg = result.prompt[0] as any;
    if (firstMsg?.content && typeof firstMsg.content === "string" && firstMsg.content.includes("[Summary")) {
      console.log(`\nFirst message is a summary:`);
      console.log(`  "${firstMsg.content.substring(0, 200)}..."`);
    }
  }
}

main().catch(console.error);
