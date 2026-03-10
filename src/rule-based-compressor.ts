import type {
  CompressionModification,
  ContextMessage,
  TokenEstimator,
  ToolOutputConfig,
  ToolOutputPolicy,
  ToolOutputTruncationEvent,
} from "./types.js";

interface ToolPolicyOptions {
  estimator: TokenEstimator;
  toolOutput: Required<Pick<ToolOutputConfig, "defaultPolicy" | "maxTokens" | "recentFullCount">> & {
    toolOverrides: Record<string, ToolOutputPolicy>;
  };
  onToolOutputTruncated?: (
    event: ToolOutputTruncationEvent
  ) => string | undefined | void | Promise<string | undefined | void>;
}

interface ToolPolicyResult {
  messages: ContextMessage[];
  modifications: CompressionModification[];
  tokenEstimate: number;
}

function countToolResultsFromEnd(messages: ContextMessage[]): Map<number, number> {
  const positions = new Map<number, number>();
  let toolCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].entryType === "tool-result") {
      positions.set(i, toolCount);
      toolCount++;
    }
  }

  return positions;
}

function resolveToolName(
  messages: ContextMessage[],
  toolResultIndex: number,
  toolCallId: string | undefined
): string | undefined {
  if (!toolCallId) {
    return messages[toolResultIndex].toolName;
  }

  for (let i = toolResultIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.entryType === "tool-call" && message.toolCallId === toolCallId) {
      return message.toolName;
    }
  }

  return messages[toolResultIndex].toolName;
}

function truncateText(text: string, maxTokens: number, charsPerToken = 4): string {
  const maxChars = maxTokens * charsPerToken;
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[...truncated]`;
}

export async function applyToolOutputPolicy(
  messages: ContextMessage[],
  options: ToolPolicyOptions
): Promise<ToolPolicyResult> {
  const { estimator, toolOutput, onToolOutputTruncated } = options;
  const modifications: CompressionModification[] = [];
  const result: ContextMessage[] = [];
  const toolPositions = countToolResultsFromEnd(messages);

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.entryType !== "tool-result") {
      result.push(message);
      continue;
    }

    const toolName = resolveToolName(messages, i, message.toolCallId) ?? "unknown";
    const policy = toolOutput.toolOverrides[toolName] ?? toolOutput.defaultPolicy;
    const positionFromEnd = toolPositions.get(i) ?? Infinity;

    if (positionFromEnd < toolOutput.recentFullCount && policy !== "remove") {
      result.push(message);
      continue;
    }

    const originalTokens = estimator.estimateMessage(message);
    const originalText = message.content;

    if (policy === "keep") {
      result.push(message);
      continue;
    }

    const event: ToolOutputTruncationEvent = {
      toolName,
      toolCallId: message.toolCallId,
      messageIndex: i,
      originalOutput: originalText,
      originalTokens,
      removed: policy === "remove",
    };

    const overrideText = onToolOutputTruncated ? await onToolOutputTruncated(event) : undefined;

    if (policy === "remove") {
      const removedMessage: ContextMessage = {
        ...message,
        toolName,
        content: typeof overrideText === "string" && overrideText.length > 0
          ? overrideText
          : "[Tool output removed for brevity]",
      };
      result.push(removedMessage);
      modifications.push({
        type: "tool-output-removed",
        messageIndex: i,
        originalTokens,
        compressedTokens: estimator.estimateMessage(removedMessage),
        toolName,
        toolCallId: message.toolCallId,
        originalText,
      });
      continue;
    }

    const truncatedText = typeof overrideText === "string" && overrideText.length > 0
      ? overrideText
      : truncateText(originalText, toolOutput.maxTokens);

    if (truncatedText === originalText) {
      result.push(message);
      continue;
    }

    const truncatedMessage: ContextMessage = {
      ...message,
      toolName,
      content: truncatedText,
    };
    result.push(truncatedMessage);
    modifications.push({
      type: "tool-output-truncated",
      messageIndex: i,
      originalTokens,
      compressedTokens: estimator.estimateMessage(truncatedMessage),
      toolName,
      toolCallId: message.toolCallId,
      originalText,
    });
  }

  return {
    messages: result,
    modifications,
    tokenEstimate: estimator.estimateMessages(result),
  };
}
