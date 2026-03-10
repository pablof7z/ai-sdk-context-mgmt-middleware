import { describe, test, expect } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { contextMessagesToPrompt, normalizeMessages, promptToContextMessages } from "../messages.js";
import { hashValue } from "../cache.js";

describe("normalizeMessages", () => {
  test("uses deterministic hashes for plain messages and suffixes duplicates", () => {
    const baseId = hashValue("user:hello").slice(0, 8);
    const messages = normalizeMessages([
      { role: "user", content: "hello" },
      { role: "user", content: "hello" },
    ]);

    expect(messages.map((message) => message.id)).toEqual([baseId, `${baseId}-2`]);
  });

  test("uses tool call ids for tool entries", () => {
    const prompt: LanguageModelV3Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search", input: { q: "x" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "search",
          output: { type: "text", value: "result" },
        }],
      },
    ];

    const messages = promptToContextMessages(prompt);

    expect(messages[0].id).toBe("call-1:call");
    expect(messages[1].id).toBe("call-1:result");
  });
});

describe("contextMessagesToPrompt", () => {
  test("rebuilds modified tool calls as AI SDK tool-call messages", () => {
    const prompt: LanguageModelV3Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "fs_write", input: { path: "/tmp/file", content: "abc" } }],
      },
    ];

    const messages = promptToContextMessages(prompt);
    messages[0] = {
      ...messages[0],
      content: "[Tool call input removed for brevity]",
    };

    const rebuiltPrompt = contextMessagesToPrompt(messages);
    const toolCallMessage = rebuiltPrompt[0];

    expect(toolCallMessage.role).toBe("assistant");
    expect((toolCallMessage.content[0] as any).type).toBe("tool-call");
    expect((toolCallMessage.content[0] as any).input).toEqual({
      _contextManagementInput: "[Tool call input removed for brevity]",
    });
  });

  test("rebuilds modified tool results as AI SDK tool messages", () => {
    const prompt: LanguageModelV3Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search", input: { q: "x" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "search",
          output: { type: "text", value: "original" },
        }],
      },
    ];

    const messages = promptToContextMessages(prompt);
    messages[1] = {
      ...messages[1],
      content: "truncated",
    };

    const rebuiltPrompt = contextMessagesToPrompt(messages);
    const toolMessage = rebuiltPrompt[1];

    expect(toolMessage.role).toBe("tool");
    expect((toolMessage.content[0] as any).output).toEqual({ type: "text", value: "truncated" });
  });
});
