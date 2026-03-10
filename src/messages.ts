import type {
  LanguageModelV3Message,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type { ContextEntryType, ContextMessage, ContextMessageInput } from "./types.js";
import { hashValue } from "./cache.js";

const SHORT_ID_LENGTH = 8;
const ORIGINAL_MESSAGE_KEY = "__originalMessage";
const ORIGINAL_CONTENT_KEY = "__originalContent";
const ORIGINAL_TOOL_CALL_INPUT_KEY = "__originalToolCallInput";

function shortHash(value: string): string {
  return hashValue(value).slice(0, SHORT_ID_LENGTH) || "msg";
}

function uniqueId(baseId: string, counts: Map<string, number>): string {
  const next = (counts.get(baseId) ?? 0) + 1;
  counts.set(baseId, next);
  return next === 1 ? baseId : `${baseId}-${next}`;
}

function inferEntryType(message: ContextMessageInput): ContextEntryType {
  if (message.entryType) return message.entryType;
  if (message.role === "tool") return "tool-result";
  if (message.toolCallId) return "tool-call";
  return "text";
}

function buildBaseId(message: ContextMessageInput, entryType: ContextEntryType): string {
  if (entryType === "tool-call" && message.toolCallId) {
    return `${message.toolCallId}:call`;
  }

  if (entryType === "tool-result" && message.toolCallId) {
    return `${message.toolCallId}:result`;
  }

  return message.id ?? shortHash(`${message.role}:${message.content}`);
}

function extractTextParts(parts: Array<LanguageModelV3TextPart | { type: string; text?: string }>): string {
  const texts = parts
    .filter((part): part is LanguageModelV3TextPart => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text);

  if (texts.length > 0) {
    return texts.join("\n");
  }

  return JSON.stringify(parts);
}

function formatToolResultOutput(output: LanguageModelV3ToolResultOutput | unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (!output || typeof output !== "object") {
    return JSON.stringify(output);
  }

  if ((output as any).type === "text" && typeof (output as any).value === "string") {
    return (output as any).value;
  }

  if ((output as any).type === "json") {
    return JSON.stringify((output as any).value);
  }

  return JSON.stringify(output);
}

function extractToolCallText(content: any[]): {
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
} {
  const toolCallPart = content.find((part): part is LanguageModelV3ToolCallPart => part?.type === "tool-call");
  if (!toolCallPart) {
    return { content: JSON.stringify(content) };
  }

  const input = (toolCallPart as any).input ?? (toolCallPart as any).args ?? {};
  const textParts = extractTextParts(content.filter((part) => part?.type === "text"));
  const callText = `${toolCallPart.toolName}(${JSON.stringify(input)})`;

  return {
    content: textParts ? `${textParts}\n${callText}` : callText,
    toolCallId: typeof toolCallPart.toolCallId === "string" ? toolCallPart.toolCallId : undefined,
    toolName: typeof toolCallPart.toolName === "string" ? toolCallPart.toolName : undefined,
    toolInput: input,
  };
}

function extractToolResultText(content: any[]): { content: string; toolCallId?: string; toolName?: string } {
  const toolResultPart = content.find((part): part is LanguageModelV3ToolResultPart => part?.type === "tool-result");
  if (!toolResultPart) {
    return { content: JSON.stringify(content) };
  }

  const legacyContent = (toolResultPart as any).content;
  let text = "";

  if (legacyContent !== undefined) {
    if (typeof legacyContent === "string") {
      text = legacyContent;
    } else if (Array.isArray(legacyContent)) {
      text = extractTextParts(legacyContent);
    } else {
      text = JSON.stringify(legacyContent);
    }
  } else {
    text = formatToolResultOutput(toolResultPart.output);
  }

  return {
    content: text,
    toolCallId: typeof toolResultPart.toolCallId === "string" ? toolResultPart.toolCallId : undefined,
    toolName: typeof toolResultPart.toolName === "string" ? toolResultPart.toolName : undefined,
  };
}

export function normalizeMessages(messages: ContextMessageInput[]): ContextMessage[] {
  const idCounts = new Map<string, number>();

  return messages.map((message) => {
    const entryType = inferEntryType(message);
    const id = uniqueId(buildBaseId(message, entryType), idCounts);

    return {
      ...message,
      id,
      entryType,
    };
  });
}

export function promptToContextMessages(prompt: LanguageModelV3Message[]): ContextMessage[] {
  const messages: ContextMessageInput[] = prompt.map((message) => {
    if (message.role === "system") {
      return {
        role: "system",
        content: message.content,
        metadata: {
          [ORIGINAL_MESSAGE_KEY]: message,
          [ORIGINAL_CONTENT_KEY]: message.content,
        },
      };
    }

    const content = message.content;

    if (message.role === "tool") {
      const result = extractToolResultText(content as any[]);
      return {
        role: "tool",
        content: result.content,
        entryType: "tool-result",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        metadata: {
          [ORIGINAL_MESSAGE_KEY]: message,
          [ORIGINAL_CONTENT_KEY]: result.content,
        },
      };
    }

    if (message.role === "assistant" && content.some((part) => part.type === "tool-call")) {
      const result = extractToolCallText(content as any[]);
      return {
        role: "assistant",
        content: result.content,
        entryType: "tool-call",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        metadata: {
          [ORIGINAL_MESSAGE_KEY]: message,
          [ORIGINAL_CONTENT_KEY]: result.content,
          [ORIGINAL_TOOL_CALL_INPUT_KEY]: result.toolInput,
        },
      };
    }

    const extractedContent = extractTextParts(content as any[]);

    return {
      role: message.role,
      content: extractedContent,
      entryType: "text",
      metadata: {
        [ORIGINAL_MESSAGE_KEY]: message,
        [ORIGINAL_CONTENT_KEY]: extractedContent,
      },
    } as ContextMessageInput;
  });

  return normalizeMessages(messages);
}

function createTextPromptMessage(message: ContextMessage): LanguageModelV3Message {
  if (message.role === "system") {
    return {
      role: "system",
      content: message.content,
    };
  }

  return {
    role: message.role === "tool" ? "assistant" : message.role,
    content: [{ type: "text", text: message.content }],
  } as LanguageModelV3Message;
}

function createToolCallPromptMessage(message: ContextMessage): LanguageModelV3Message {
  const originalMessage = message.metadata?.[ORIGINAL_MESSAGE_KEY] as LanguageModelV3Message | undefined;
  const originalContent = message.metadata?.[ORIGINAL_CONTENT_KEY] as string | undefined;
  const originalPart = originalMessage?.role === "assistant"
    ? originalMessage.content.find((part) => part.type === "tool-call")
    : undefined;

  const input = originalContent === message.content
    ? message.metadata?.[ORIGINAL_TOOL_CALL_INPUT_KEY] ?? { _contextManagementInput: message.content }
    : { _contextManagementInput: message.content };

  return {
    role: "assistant",
    providerOptions: originalMessage?.providerOptions,
    content: [{
      type: "tool-call",
      toolCallId: message.toolCallId ?? "tool-call",
      toolName: message.toolName ?? "tool",
      input,
      providerExecuted: (originalPart as any)?.providerExecuted,
      providerOptions: (originalPart as any)?.providerOptions,
    }],
  } as LanguageModelV3Message;
}

function createToolResultPromptMessage(message: ContextMessage): LanguageModelV3Message {
  const originalMessage = message.metadata?.[ORIGINAL_MESSAGE_KEY] as LanguageModelV3Message | undefined;
  const originalPart = originalMessage?.role === "tool" ? originalMessage.content[0] : undefined;

  return {
    role: "tool",
    providerOptions: originalMessage?.providerOptions,
    content: [{
      type: "tool-result",
      toolCallId: message.toolCallId ?? "tool-call",
      toolName: message.toolName ?? "tool",
      output: { type: "text", value: message.content },
      providerOptions: (originalPart as any)?.providerOptions,
    }],
  };
}

export function contextMessagesToPrompt(messages: ContextMessage[]): LanguageModelV3Message[] {
  return messages.map((message) => {
    const originalMessage = message.metadata?.[ORIGINAL_MESSAGE_KEY] as LanguageModelV3Message | undefined;
    const originalContent = message.metadata?.[ORIGINAL_CONTENT_KEY] as string | undefined;

    if (originalMessage && originalContent === message.content && message.entryType !== "summary") {
      return originalMessage;
    }

    if (message.entryType === "tool-call") {
      return createToolCallPromptMessage(message);
    }

    if (message.entryType === "tool-result") {
      return createToolResultPromptMessage(message);
    }

    return createTextPromptMessage(message);
  });
}
