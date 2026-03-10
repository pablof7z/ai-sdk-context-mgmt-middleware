import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { LLMCompressor } from "./types.js";

interface LLMCompressorConfig {
  /**
   * Function that takes a prompt string and returns the LLM's response.
   * This is intentionally provider-agnostic — wrap your preferred LLM here.
   */
  generate: (prompt: string) => Promise<string>;
}

const COMPRESSION_PROMPT_TEMPLATE = `You are a conversation compression assistant. Your task is to compress the following conversation history into a concise summary that preserves:

1. Key decisions made
2. Important facts and data discovered
3. Current state of any ongoing task
4. Critical context needed to continue the conversation

The system context is: {systemPrompt}

{conversation}

Target length: approximately {targetTokens} tokens ({targetChars} characters).

Be precise and factual. Preserve specific names, numbers, and technical details. Do NOT add commentary or meta-language. Output ONLY the compressed summary.`;

/**
 * Format a message array into a human-readable conversation string.
 */
function formatConversation(messages: LanguageModelV3Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // System handled separately

    const parts = (msg as any).content;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (part.type === "text" && part.text) {
        const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "Tool";
        lines.push(`[${role}]: ${part.text}`);
      } else if (part.type === "tool-call") {
        lines.push(`[Assistant called ${part.toolName}(${JSON.stringify(part.args)})]`);
      } else if (part.type === "tool-result") {
        const text = part.content?.find((c: any) => c.type === "text")?.text || "";
        lines.push(`[Tool result]: ${text}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Create an LLM-assisted compressor.
 *
 * The compressor takes conversation messages, formats them into a prompt,
 * sends them to an LLM for summarization, and returns a single compressed
 * user message containing the summary.
 */
export function createLLMCompressor(config: LLMCompressorConfig): LLMCompressor {
  return {
    async compress(
      messages: LanguageModelV3Message[],
      targetTokens: number,
      options?: { systemPrompt?: string }
    ): Promise<LanguageModelV3Message[]> {
      const conversation = formatConversation(messages);
      const targetChars = targetTokens * 4;

      const prompt = COMPRESSION_PROMPT_TEMPLATE
        .replace("{systemPrompt}", options?.systemPrompt || "General assistant")
        .replace("{conversation}", conversation)
        .replace("{targetTokens}", String(targetTokens))
        .replace("{targetChars}", String(targetChars));

      const summary = await config.generate(prompt);

      const trimmed = summary.trim();

      return [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: trimmed
                ? `[Compressed conversation history]\n${trimmed}`
                : "[Compressed conversation history]",
            },
          ],
        },
      ];
    },
  };
}
