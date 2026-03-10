/**
 * Example 01: Basic Usage
 *
 * Demonstrates how to wire the context management middleware into
 * an AI SDK model. Shows that messages pass through unmodified when
 * the conversation is under the token threshold.
 */
import { contextManagement, createDefaultEstimator } from "../src/index.js";
import type { LanguageModelV3Message } from "@ai-sdk/provider";

async function main() {
  console.log("=== Example 01: Basic Usage ===\n");

  // 1. Create the middleware with a generous threshold
  const estimator = createDefaultEstimator();
  const middleware = contextManagement({
    maxTokens: 8_000,
    tokenEstimator: estimator,
    // No compression thresholds means no compression triggers
    thresholds: { tier1: 0.7, tier2: 0.9 },
  });

  // 2. Build a small conversation (well under 8k tokens)
  const messages: LanguageModelV3Message[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: [{ type: "text", text: "What is 2 + 2?" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "2 + 2 equals 4." }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "And what about 3 + 3?" }],
    },
  ];

  const tokenCount = estimator.estimateMessages(messages);
  console.log(`Conversation has ~${tokenCount} tokens (threshold: 8000)`);
  console.log(`Ratio: ${(tokenCount / 8000).toFixed(2)} (tier1 triggers at 0.7)\n`);

  // 3. Run the middleware's transformParams hook
  const transformed = await middleware.transformParams!({
    type: "generate",
    params: {
      type: "generate",
      messages,
      maxOutputTokens: 1024,
      inputFormat: "messages",
      mode: { type: "regular" },
    },
  } as any);

  // 4. Verify: messages should pass through unchanged
  const outMessages = (transformed as any).messages;
  console.log(`Input messages:  ${messages.length}`);
  console.log(`Output messages: ${outMessages.length}`);

  if (outMessages.length === messages.length) {
    console.log("\n✅ Messages passed through unchanged — no compression needed");
  } else {
    console.log("\n❌ Unexpected: messages were modified");
  }

  // 5. Show how you'd wire this into a real model
  console.log("\n--- Real-world wiring ---");
  console.log(`
  import { wrapLanguageModel } from "ai";
  import { ollama } from "ollama-ai-provider";

  const model = wrapLanguageModel({
    model: ollama("llama3"),
    middleware: contextManagement({
      maxTokens: 8000,
      thresholds: { tier1: 0.7, tier2: 0.9 },
    }),
  });

  // Now use 'model' with generateText(), streamText(), etc.
  // The middleware automatically manages context when conversations grow.
  `);
}

main().catch(console.error);
