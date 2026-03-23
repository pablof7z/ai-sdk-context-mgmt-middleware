import type { LanguageModelV3Prompt, LanguageModelV3Usage } from "@ai-sdk/provider";
import type {
  ScratchpadConversationEntry,
  ScratchpadState,
  ScratchpadStore,
  ScratchpadStoreKey,
} from "../types.js";

function cloneState(state: ScratchpadState): ScratchpadState {
  return {
    ...state,
    ...(state.entries ? { entries: { ...state.entries } } : {}),
    ...(state.activeNotice ? { activeNotice: { ...state.activeNotice } } : {}),
    omitToolCallIds: [...state.omitToolCallIds],
  };
}

export class InMemoryScratchpadStore implements ScratchpadStore {
  private readonly values = new Map<string, ScratchpadState>();

  private key(key: ScratchpadStoreKey): string {
    return `${key.conversationId}:${key.agentId}`;
  }

  async get(key: ScratchpadStoreKey): Promise<ScratchpadState | undefined> {
    const value = this.values.get(this.key(key));
    return value ? cloneState(value) : undefined;
  }

  async set(key: ScratchpadStoreKey, state: ScratchpadState): Promise<void> {
    this.values.set(this.key(key), cloneState(state));
  }

  async listConversation(conversationId: string): Promise<ScratchpadConversationEntry[]> {
    const entries: ScratchpadConversationEntry[] = [];

    for (const [key, state] of this.values.entries()) {
      const [entryConversationId, agentId] = key.split(":");
      if (entryConversationId !== conversationId) {
        continue;
      }

      entries.push({
        agentId,
        agentLabel: state.agentLabel,
        state: cloneState(state),
      });
    }

    return entries;
  }
}

export function usage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: 10,
      noCache: 10,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 10,
      text: 10,
      reasoning: undefined,
    },
  };
}

export function makePrompt(): LanguageModelV3Prompt {
  return [
    { role: "system", content: "You are helpful." },
    { role: "user", content: [{ type: "text", text: "old user" }] },
    { role: "assistant", content: [{ type: "text", text: "old assistant" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-old", toolName: "fs_read", input: { path: "a.ts" } }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-old", toolName: "fs_read", output: { type: "text", value: "contents" } }],
    },
    { role: "user", content: [{ type: "text", text: "latest user" }] },
  ];
}
