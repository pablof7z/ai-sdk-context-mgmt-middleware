/**
 * Example 04: Full pipeline with cache + segment store + generator helper.
 */
import {
  createCompressionCache,
  createContextManagementMiddleware,
  createSegmentGenerator,
} from "ai-sdk-context-mgmt-middleware";
import { generateConversation, generateToolExchange, printPrompt, runMiddlewareTransform } from "./helpers.js";

async function main() {
  console.log("=== Example 04: Full pipeline ===\n");

  const externalStore = new Map<string, string>();
  const segmentStore = new Map<string, any[]>();
  const cache = createCompressionCache<any>(20);
  let llmCalls = 0;

  const middleware = createContextManagementMiddleware({
    maxTokens: 520,
    compressionThreshold: 0.65,
    protectedTailCount: 3,
    cache,
    segmentStore: {
      load: (conversationKey) => segmentStore.get(conversationKey) ?? [],
      append: (conversationKey, segments) => {
        segmentStore.set(conversationKey, [...(segmentStore.get(conversationKey) ?? []), ...segments]);
      },
    },
    resolveConversationKey({ params }) {
      return (params.providerOptions as any).contextManagement.conversationId;
    },
    toolPolicy: ({ toolName, call, result, exchangePositionFromEnd }) => ({
      call: call && call.tokens > 80 ? { policy: "truncate", maxTokens: exchangePositionFromEnd === 0 ? 64 : 32 } : undefined,
      result: toolName === "important_data"
        ? { policy: "keep" }
        : toolName === "logs"
          ? { policy: "remove" }
          : result && result.tokens > 120
            ? { policy: "truncate", maxTokens: exchangePositionFromEnd === 0 ? 80 : 40 }
            : undefined,
    }),
    onToolContentTruncated: async (event) => {
      const storageId = `store_${event.entryType}_${event.toolName}_${event.toolCallId}`;
      externalStore.set(storageId, event.originalContent);
      if (event.removed) {
        return `[Content removed. Retrieve with externalStore.get("${storageId}")]`;
      }
      return undefined;
    },
    segmentGenerator: createSegmentGenerator({
      async generate(prompt) {
        llmCalls++;
        const transcriptRangeMatch = prompt.match(/Transcript ids run from (\S+) to (\S+)\./m);
        const firstId = transcriptRangeMatch?.[1] ?? "unknown";
        const lastId = transcriptRangeMatch?.[2] ?? firstId;
        return JSON.stringify({
          segments: [{
            fromId: firstId,
            toId: lastId,
            compressed: "Compressed project history with tool findings and pending work.",
          }],
        });
      },
    }),
    onDebug: (info) => {
      console.log(
        `[debug] cacheHit=${info.cacheHit}, modifications=${info.modifications.length}, ` +
        `newSegments=${info.newSegments.length}, tokens ${info.originalTokenEstimate} -> ${info.compressedTokenEstimate}`
      );
    },
  });

  const prompt = [
    ...generateConversation(4),
    ...generateToolExchange("fs_read", 180),
    ...generateConversation(2),
    ...generateToolExchange("logs", 220),
    ...generateToolExchange("important_data", 90),
    ...generateConversation(2),
  ];
  const providerOptions = { contextManagement: { conversationId: "conv-full-pipeline" } };

  console.log("-- first call --");
  const firstOutput = await runMiddlewareTransform(middleware, prompt, providerOptions);
  printPrompt("first output", firstOutput);
  console.log(`segment store size: ${segmentStore.get("conv-full-pipeline")?.length ?? 0}`);
  console.log(`cache size: ${cache.size}`);
  console.log(`external store size: ${externalStore.size}`);
  console.log(`generator calls: ${llmCalls}`);

  console.log("\n-- second call (segment reuse expected) --");
  const secondOutput = await runMiddlewareTransform(middleware, prompt, providerOptions);
  printPrompt("second output", secondOutput);
  console.log(`segment store size: ${segmentStore.get("conv-full-pipeline")?.length ?? 0}`);
  console.log(`cache size: ${cache.size}`);
  console.log(`external store size: ${externalStore.size}`);
  console.log(`generator calls: ${llmCalls}`);

  console.log("\n-- third call (cache hit expected) --");
  const thirdOutput = await runMiddlewareTransform(middleware, prompt, providerOptions);
  printPrompt("third output", thirdOutput);
  console.log(`segment store size: ${segmentStore.get("conv-full-pipeline")?.length ?? 0}`);
  console.log(`cache size: ${cache.size}`);
  console.log(`external store size: ${externalStore.size}`);
  console.log(`generator calls: ${llmCalls}`);
}

main().catch(console.error);
