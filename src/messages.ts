import type {
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type {
  ContextCompressionMessage,
  ContextEntryType,
  ContextMessage,
  ContextMessageInput,
} from "./types.js";

const ORIGINAL_MESSAGE_KEY = "__originalMessage";
const ORIGINAL_CONTENT_KEY = "__originalContent";
const ORIGINAL_TOOL_CALL_INPUT_KEY = "__originalToolCallInput";

function inferEntryType(message: ContextMessageInput): ContextEntryType {
  if (message.entryType) return message.entryType;
  if (message.role === "tool") return "tool-result";
  if (message.toolCallId) return "tool-call";
  return "text";
}

function assertMessageId(id: unknown, index: number): asserts id is string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`messages[${index}].id must be a non-empty string`);
  }
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

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return extractTextParts(content as Array<LanguageModelV3TextPart | { type: string; text?: string }>);
  }

  if (content === undefined) {
    return "";
  }

  return JSON.stringify(content);
}

function isToolCallPart(part: unknown): part is LanguageModelV3ToolCallPart {
  return typeof part === "object" && part !== null && (part as any).type === "tool-call";
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
  const seenIds = new Set<string>();

  return messages.map((message, index) => {
    assertMessageId(message.id, index);

    if (seenIds.has(message.id)) {
      throw new Error(`Duplicate message id "${message.id}" at messages[${index}]`);
    }

    seenIds.add(message.id);
    const entryType = inferEntryType(message);

    return {
      ...message,
      id: message.id,
      entryType,
    };
  });
}

export function messagesToContextMessages(messages: ContextCompressionMessage[]): ContextMessage[] {
  return normalizeMessages(messages.map((message) => {
    if (message.role === "system") {
      return {
        id: message.id,
        sourceRecordId: message.sourceRecordId,
        role: "system",
        content: extractTextContent(message.content),
        metadata: {
          [ORIGINAL_MESSAGE_KEY]: message,
          [ORIGINAL_CONTENT_KEY]: extractTextContent(message.content),
        },
      };
    }

    const content = message.content;

    if (message.role === "tool") {
      const result = Array.isArray(content)
        ? extractToolResultText(content as any[])
        : { content: extractTextContent(content) };
      return {
        id: message.id,
        sourceRecordId: message.sourceRecordId,
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

    if (message.role === "assistant" && Array.isArray(content) && content.some(isToolCallPart)) {
      const result = extractToolCallText(content as any[]);
      return {
        id: message.id,
        sourceRecordId: message.sourceRecordId,
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

    const extractedContent = extractTextContent(content);

    return {
      id: message.id,
      sourceRecordId: message.sourceRecordId,
      role: message.role,
      content: extractedContent,
      entryType: "text",
      metadata: {
        [ORIGINAL_MESSAGE_KEY]: message,
        [ORIGINAL_CONTENT_KEY]: extractedContent,
      },
    } as ContextMessageInput;
  }));
}

function createTextMessage(message: ContextMessage): ContextCompressionMessage {
  const originalMessage = message.metadata?.[ORIGINAL_MESSAGE_KEY] as ContextCompressionMessage | undefined;

  if (message.role === "system") {
    return {
      id: message.id,
      sourceRecordId: originalMessage?.sourceRecordId,
      role: "system",
      content: message.content,
      providerOptions: originalMessage?.providerOptions,
    };
  }

  const outputRole = message.role === "tool" ? "assistant" : message.role;

  if (!originalMessage || typeof originalMessage.content === "string") {
    return {
      id: message.id,
      sourceRecordId: originalMessage?.sourceRecordId,
      role: outputRole,
      providerOptions: originalMessage?.providerOptions,
      content: message.content,
    } as ContextCompressionMessage;
  }

  return {
    id: message.id,
    sourceRecordId: originalMessage?.sourceRecordId,
    role: outputRole,
    providerOptions: originalMessage?.providerOptions,
    content: [{ type: "text", text: message.content }],
  } as ContextCompressionMessage;
}

function createToolCallMessage(message: ContextMessage): ContextCompressionMessage {
  const originalMessage = message.metadata?.[ORIGINAL_MESSAGE_KEY] as ContextCompressionMessage | undefined;
  const originalContent = message.metadata?.[ORIGINAL_CONTENT_KEY] as string | undefined;
  const originalPart = originalMessage?.role === "assistant"
    ? Array.isArray(originalMessage.content)
      ? originalMessage.content.find(isToolCallPart)
      : undefined
    : undefined;

  const input = originalContent === message.content
    ? message.metadata?.[ORIGINAL_TOOL_CALL_INPUT_KEY] ?? { _contextCompressionInput: message.content }
    : { _contextCompressionInput: message.content };

  return {
    id: message.id,
    sourceRecordId: originalMessage?.sourceRecordId,
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
  } as ContextCompressionMessage;
}

function createToolResultMessage(message: ContextMessage): ContextCompressionMessage {
  const originalMessage = message.metadata?.[ORIGINAL_MESSAGE_KEY] as ContextCompressionMessage | undefined;
  const originalPart = originalMessage?.role === "tool" ? originalMessage.content[0] : undefined;

  return {
    id: message.id,
    sourceRecordId: originalMessage?.sourceRecordId,
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

export function contextMessagesToMessages(messages: ContextMessage[]): ContextCompressionMessage[] {
  return messages.map((message) => {
    const originalMessage = message.metadata?.[ORIGINAL_MESSAGE_KEY] as ContextCompressionMessage | undefined;
    const originalContent = message.metadata?.[ORIGINAL_CONTENT_KEY] as string | undefined;

    if (originalMessage && originalContent === message.content && message.entryType !== "summary") {
      return originalMessage;
    }

    if (message.entryType === "tool-call") {
      return createToolCallMessage(message);
    }

    if (message.entryType === "tool-result") {
      return createToolResultMessage(message);
    }

    return createTextMessage(message);
  });
}
