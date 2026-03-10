/**
 * Shared helpers for generating synthetic conversation messages.
 */
import type { CoreMessage, CoreToolMessage } from "ai";

/**
 * Generate a synthetic user/assistant conversation of N turns.
 */
export function generateConversation(turns: number): CoreMessage[] {
  const messages: CoreMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "user",
      content: `This is user message ${i + 1}. ${generatePadding(100)}`,
    });
    messages.push({
      role: "assistant",
      content: `This is assistant response ${i + 1}. ${generatePadding(150)}`,
    });
  }
  return messages;
}

/**
 * Generate a tool call + tool result message pair.
 */
export function generateToolExchange(
  toolName: string,
  outputSize: number
): CoreMessage[] {
  const toolCallId = `call_${toolName}_${Date.now()}`;
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName,
          args: { query: `test query for ${toolName}` },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName,
          result: generatePadding(outputSize),
        },
      ],
    } as CoreToolMessage,
  ];
}

/**
 * Generate padding text of approximately N words.
 */
export function generatePadding(words: number): string {
  const vocab = [
    "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
    "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "labore",
    "magna", "aliqua", "enim", "minim", "veniam", "quis", "nostrud",
    "exercitation", "ullamco", "laboris", "nisi", "aliquip", "commodo",
    "consequat", "duis", "aute", "irure", "dolor", "reprehenderit",
    "voluptate", "velit", "esse", "cillum", "fugiat", "nulla", "pariatur",
    "excepteur", "sint", "occaecat", "cupidatat", "proident", "sunt",
    "culpa", "officia", "deserunt", "mollit", "anim", "id", "est",
  ];
  const result: string[] = [];
  for (let i = 0; i < words; i++) {
    result.push(vocab[i % vocab.length]);
  }
  return result.join(" ");
}
