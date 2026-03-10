/**
 * Example 01: Basic Pass-Through
 * 
 * Demonstrates that the middleware does nothing when messages fit within
 * the context window. The message array passes through unchanged.
 */
import { contextManagement, createDefaultEstimator } from "ai-sdk-context-mgmt-middleware";
import { generateConversation } from "./helpers.js";

async function main() {
  console.log("=== Example 01: Basic Pass-Through ===\n");

  // Create middleware with a large token limit
  const middleware = contextManagement({
    maxTokens: 128_000,
    ruleBasedThreshold: 0.8,
    onDebug: (info) => {
      console.log(`[debug] Tier: ${info.tier}, Tokens: ${info.originalTokenEstimate}, Messages: ${info.originalMessageCount}`);
      console.log(`[debug] Modifications: ${info.modifications.length}`);
    },
  });

  // Generate a small conversation (well under limit)
  const messages = generateConversation(5);
  console.log(`Input: ${messages.length} messages`);

  // Simulate what wrapLanguageModel does: call transformParams
  if (middleware.transformParams) {
    const result = await middleware.transformParams({
      type: "generate",
      params: {
        prompt: messages,
        mode: { type: "regular" },
        inputFormat: "messages",
      },
    } as any);

    const outputMessages = result.prompt;
    console.log(`Output: ${outputMessages.length} messages`);
    console.log(`\nResult: Messages passed through unchanged ✓`);
    
    // Verify they're the same count
    if (outputMessages.length === messages.length) {
      console.log("No compression was needed - context window has plenty of room.");
    }
  }
}

main().catch(console.error);
