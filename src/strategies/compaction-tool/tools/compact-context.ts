import type { ModelMessage } from "ai";
import { jsonSchema, tool } from "ai";
import { CONTEXT_MANAGEMENT_KEY } from "../../../types.js";
import type {
  CompactionEdit,
  CompactionToolInput,
  CompactionToolResult,
  ContextManagementRequestContext,
} from "../../../types.js";
import {
  extractCompactionSummaryRange,
  extractMessageAnchor,
  getMessageTextContent,
  isCompactionSummaryMessage,
  normalizeCompactionText,
} from "../shared.js";

type VisibleCompactionCandidate = {
  promptIndex: number;
  normalizedText: string;
  range: {
    start: NonNullable<CompactionEdit["start"]>;
    end: NonNullable<CompactionEdit["end"]>;
  };
};

function extractRequestContextFromExperimentalContext(
  experimentalContext: unknown
): ContextManagementRequestContext {
  if (
    !experimentalContext ||
    typeof experimentalContext !== "object" ||
    !(CONTEXT_MANAGEMENT_KEY in experimentalContext)
  ) {
    throw new Error("compact_context tool requires experimental_context.contextManagement");
  }

  const raw = (experimentalContext as Record<string, unknown>)[CONTEXT_MANAGEMENT_KEY];
  if (!raw || typeof raw !== "object") {
    throw new Error("compact_context tool requires a valid contextManagement request context");
  }

  const conversationId = (raw as Record<string, unknown>).conversationId;
  const agentId = (raw as Record<string, unknown>).agentId;
  const agentLabel = (raw as Record<string, unknown>).agentLabel;

  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new Error("compact_context tool requires contextManagement.conversationId");
  }

  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new Error("compact_context tool requires contextManagement.agentId");
  }

  return {
    conversationId,
    agentId,
    ...(typeof agentLabel === "string" && agentLabel.length > 0 ? { agentLabel } : {}),
  };
}

function isEligibleManualCompactionMessage(message: ModelMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

function getProtectedTailStartIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      return index;
    }
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") {
      return index;
    }
  }

  return messages.length;
}

function buildVisibleCandidates(messages: ModelMessage[]): VisibleCompactionCandidate[] {
  const protectedTailStartIndex = getProtectedTailStartIndex(messages);

  return messages.flatMap((message, promptIndex) => {
    if (promptIndex >= protectedTailStartIndex || !isEligibleManualCompactionMessage(message)) {
      return [];
    }

    const normalizedText = getMessageTextContent(message as never);
    if (!normalizedText) {
      return [];
    }

    const summaryRange = isCompactionSummaryMessage(message as never)
      ? extractCompactionSummaryRange(message as never)
      : undefined;
    const directAnchor = summaryRange
      ? undefined
      : extractMessageAnchor(message as never);
    const range = summaryRange
      ? summaryRange
      : directAnchor
        ? { start: directAnchor, end: directAnchor }
        : undefined;

    if (!range) {
      return [];
    }

    return [{
      promptIndex,
      normalizedText,
      range,
    }];
  });
}

function findUniqueAnchorMatch(
  candidates: readonly VisibleCompactionCandidate[],
  anchorText: string | undefined
): VisibleCompactionCandidate | undefined | "ambiguous" {
  if (!anchorText) {
    return undefined;
  }

  const normalizedAnchor = normalizeCompactionText(anchorText);
  if (normalizedAnchor.length === 0) {
    return "ambiguous";
  }

  const matches = candidates.filter((candidate) => candidate.normalizedText.includes(normalizedAnchor));
  if (matches.length === 1) {
    return matches[0];
  }

  return matches.length === 0 ? undefined : "ambiguous";
}

function buildQueuedEditId(toolCallId: string | undefined): string {
  const suffix = typeof toolCallId === "string" && toolCallId.length > 0
    ? toolCallId
    : "compact-context";
  return `compact:${Date.now()}:${suffix}`;
}

function countCompactedMessages(
  messages: ModelMessage[],
  fromPromptIndex: number,
  toPromptIndex: number
): number {
  let count = 0;
  for (let index = fromPromptIndex; index <= toPromptIndex; index++) {
    if (messages[index]?.role !== "system") {
      count += 1;
    }
  }
  return count;
}

function buildError(error: string): CompactionToolResult {
  return {
    ok: false,
    error,
  };
}

export function createCompactContextTool(options: {
  queueEdit: (
    context: ContextManagementRequestContext,
    edit: CompactionEdit
  ) => true | string;
}) {
  return tool<CompactionToolInput, CompactionToolResult>({
    description: "Request host-driven compaction of stale user/assistant history into a continuation summary for future turns. Optionally provide guidance for what the summary should emphasize. Optionally provide from and to as exact quoted excerpts from visible user or assistant messages. When omitted, the compaction expands across the oldest/newest eligible historical user or assistant messages before the active tail.",
    inputSchema: jsonSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        guidance: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description: "Optional steering guidance telling the host summarizer what to emphasize in the compaction.",
        },
        from: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description: "Optional exact excerpt from the first user or assistant message to compact.",
        },
        to: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description: "Optional exact excerpt from the last user or assistant message to compact.",
        },
      },
    }),
    execute: async (input, executeOptions) => {
      const requestContext = extractRequestContextFromExperimentalContext(
        executeOptions.experimental_context
      );
      const steeringMessage = typeof input.guidance === "string"
        ? input.guidance.trim()
        : undefined;

      const candidates = buildVisibleCandidates((executeOptions.messages ?? []) as ModelMessage[]);
      if (candidates.length === 0) {
        return buildError(
          "No eligible historical user or assistant messages are available for compaction."
        );
      }

      const matchedFrom = findUniqueAnchorMatch(candidates, input.from);
      if (matchedFrom === "ambiguous") {
        return buildError("The `from` excerpt matched multiple messages. Use a more specific excerpt.");
      }

      const matchedTo = findUniqueAnchorMatch(candidates, input.to);
      if (matchedTo === "ambiguous") {
        return buildError("The `to` excerpt matched multiple messages. Use a more specific excerpt.");
      }

      const startCandidate = matchedFrom ?? candidates[0];
      const endCandidate = matchedTo ?? candidates[candidates.length - 1];

      if (input.from && !matchedFrom) {
        return buildError("The `from` excerpt did not match any eligible historical user or assistant message.");
      }

      if (input.to && !matchedTo) {
        return buildError("The `to` excerpt did not match any eligible historical user or assistant message.");
      }

      if (startCandidate.promptIndex > endCandidate.promptIndex) {
        return buildError("The selected compaction span is reversed. `from` must appear before `to`.");
      }

      const compactedMessageCount = countCompactedMessages(
        (executeOptions.messages ?? []) as ModelMessage[],
        startCandidate.promptIndex,
        endCandidate.promptIndex
      );
      const queuedEdit: CompactionEdit = {
        id: buildQueuedEditId(executeOptions.toolCallId),
        source: "manual",
        start: startCandidate.range.start,
        end: endCandidate.range.end,
        replacement: "__PENDING_HOST_COMPACTION__",
        createdAt: Date.now(),
        compactedMessageCount,
        ...(steeringMessage ? { steeringMessage } : {}),
        ...(input.from ? { fromText: normalizeCompactionText(input.from) } : {}),
        ...(input.to ? { toText: normalizeCompactionText(input.to) } : {}),
      };

      const queueResult = options.queueEdit(requestContext, queuedEdit);
      if (queueResult !== true) {
        return buildError(queueResult);
      }

      return {
        ok: true,
        queuedEditId: queuedEdit.id,
        compactedMessageCount,
        fromText: startCandidate.normalizedText,
        toText: endCandidate.normalizedText,
      };
    },
  });
}
