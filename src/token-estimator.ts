import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { TokenEstimator } from "./types.js";

const PER_MESSAGE_OVERHEAD = 4;
const CHARS_PER_TOKEN = 4;

/**
 * Extract all text content from a message, regardless of role/structure.
 */
function extractText(message: LanguageModelV3Message): string {
  if (message.role === "system") {
    return typeof message.content === "string" ? message.content : "";
  }

  const content = (message as any).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content;

  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      texts.push(part.text);
    } else if (part.type === "tool-call") {
      texts.push(part.toolName || "");
      if (part.args) texts.push(JSON.stringify(part.args));
    } else if (part.type === "tool-result") {
      // Handle CoreMessage format (result: string)
      if (typeof part.result === "string") {
        texts.push(part.result);
      }
      // Handle LanguageModelV3 format (content: [{type:"text",text:"..."}])
      if (Array.isArray(part.content)) {
        for (const c of part.content) {
          if (c.type === "text" && c.text) texts.push(c.text);
        }
      }
    }
  }

  return texts.join(" ");
}

/**
 * Create a default character-based token estimator.
 * Uses ~4 chars per token heuristic with per-message overhead.
 * For production, consider using tiktoken or a provider-specific tokenizer.
 */
export function createDefaultEstimator(): TokenEstimator {
  return {
    estimateString(text: string): number {
      return Math.ceil(text.length / CHARS_PER_TOKEN);
    },

    estimateMessage(message: LanguageModelV3Message): number {
      const text = extractText(message);
      return Math.ceil(text.length / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD;
    },

    estimateMessages(messages: LanguageModelV3Message[]): number {
      return messages.reduce((sum, msg) => sum + this.estimateMessage(msg), 0);
    },
  };
}
