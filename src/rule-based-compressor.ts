import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type {
  TokenEstimator,
  ToolOutputConfig,
  CompressionModification,
} from "./types.js";

interface RuleBasedOptions {
  estimator: TokenEstimator;
  toolOutput: Required<Pick<ToolOutputConfig, "defaultPolicy" | "maxTokens" | "recentFullCount">> & {
    toolOverrides: Record<string, string>;
  };
}

interface RuleBasedResult {
  messages: LanguageModelV3Message[];
  modifications: CompressionModification[];
  tokenEstimate: number;
}

/**
 * Resolve the tool name for a tool-result message by searching backward
 * for the matching tool-call.
 */
function resolveToolName(
  messages: LanguageModelV3Message[],
  toolResultIndex: number,
  toolCallId: string
): string | undefined {
  for (let i = toolResultIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const parts = (msg as any).content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) {
        return part.toolName;
      }
    }
  }
  return undefined;
}

/**
 * Count tool-result messages from the end of the array.
 */
function countToolResultsFromEnd(messages: LanguageModelV3Message[]): Map<number, number> {
  const positions = new Map<number, number>();
  let toolCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") {
      positions.set(i, toolCount);
      toolCount++;
    }
  }

  return positions;
}

/**
 * Truncate text to approximately maxTokens worth of characters.
 */
function truncateText(text: string, maxTokens: number, charsPerToken = 4): string {
  const maxChars = maxTokens * charsPerToken;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n[...truncated]";
}

/**
 * Apply rule-based compression to messages.
 *
 * Strategies:
 * 1. Tool output decay: Older tool results are truncated/removed more aggressively
 * 2. Per-tool policy overrides: Specific tools can have custom handling
 * 3. Message removal: In extreme cases, old messages are dropped
 */
export function applyRuleBasedCompression(
  messages: LanguageModelV3Message[],
  options: RuleBasedOptions
): RuleBasedResult {
  const { estimator, toolOutput } = options;
  const modifications: CompressionModification[] = [];
  const result: LanguageModelV3Message[] = [];
  const toolPositions = countToolResultsFromEnd(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Only compress tool-result messages
    if (msg.role !== "tool") {
      result.push(msg);
      continue;
    }

    const parts = (msg as any).content;
    if (!Array.isArray(parts) || parts.length === 0) {
      result.push(msg);
      continue;
    }

    const toolResultPart = parts[0];
    const toolCallId = toolResultPart?.toolCallId || "";
    const toolName = toolResultPart?.toolName || resolveToolName(messages, i, toolCallId);

    // Determine policy for this tool
    let policy = toolOutput.defaultPolicy;
    if (toolName && toolOutput.toolOverrides[toolName]) {
      policy = toolOutput.toolOverrides[toolName] as typeof policy;
    }

    // Check if this tool result is recent enough to keep at full fidelity
    const positionFromEnd = toolPositions.get(i) ?? Infinity;
    if (positionFromEnd < toolOutput.recentFullCount && policy !== "remove") {
      result.push(msg);
      continue;
    }

    const originalTokens = estimator.estimateMessage(msg);

    // Extract original text for hook callback
    // Handle both LanguageModelV3 format (content: [{type:"text",text:"..."}])
    // and CoreMessage format (result: "...")
    let originalText = "";
    if (typeof toolResultPart?.result === "string") {
      originalText = toolResultPart.result;
    } else if (Array.isArray(toolResultPart?.content)) {
      originalText = toolResultPart.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    } else if (typeof toolResultPart?.content === "string") {
      originalText = toolResultPart.content;
    }

    if (policy === "remove") {
      // Replace with brief placeholder
      const removedMsg: LanguageModelV3Message = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: toolName || "unknown",
            content: [{ type: "text", text: "[Tool output removed for brevity]" }],
          },
        ],
      } as any;

      result.push(removedMsg);
      const compressedTokens = estimator.estimateMessage(removedMsg);

      modifications.push({
        type: "tool-output-removed",
        messageIndex: i,
        originalTokens,
        compressedTokens,
        toolName,
        toolCallId,
        originalText,
      });
    } else if (policy === "truncate") {
      const truncated = truncateText(originalText, toolOutput.maxTokens);

      if (truncated !== originalText) {
        const truncatedMsg: LanguageModelV3Message = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: toolName || "unknown",
              content: [{ type: "text", text: truncated }],
            },
          ],
        } as any;

        result.push(truncatedMsg);
        const compressedTokens = estimator.estimateMessage(truncatedMsg);

        modifications.push({
          type: "tool-output-truncated",
          messageIndex: i,
          originalTokens,
          compressedTokens,
          toolName,
          toolCallId,
          originalText,
        });
      } else {
        result.push(msg);
      }
    } else {
      // "keep" — no compression
      result.push(msg);
    }
  }

  return {
    messages: result,
    modifications,
    tokenEstimate: estimator.estimateMessages(result),
  };
}
