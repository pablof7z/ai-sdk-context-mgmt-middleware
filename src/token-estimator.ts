import type { ContextMessage, TokenEstimator } from "./types.js";

const PER_MESSAGE_OVERHEAD = 4;
const CHARS_PER_TOKEN = 4;

function estimateContextMessageChars(message: ContextMessage): number {
  let total = message.content.length;

  if (message.toolCallId) {
    total += message.toolCallId.length;
  }
  if (message.toolName) {
    total += message.toolName.length;
  }
  if (message.attributes) {
    total += JSON.stringify(message.attributes).length;
  }

  return total;
}

export function createDefaultEstimator(): TokenEstimator {
  return {
    estimateString(text: string): number {
      return Math.ceil(text.length / CHARS_PER_TOKEN);
    },

    estimateMessage(message: ContextMessage): number {
      return Math.ceil(estimateContextMessageChars(message) / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD;
    },

    estimateMessages(messages: ContextMessage[]): number {
      return messages.reduce((sum, message) => sum + this.estimateMessage(message), 0);
    },
  };
}
