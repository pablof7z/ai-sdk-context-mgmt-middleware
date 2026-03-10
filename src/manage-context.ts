import type {
  CompressionModification,
  CompressionSegment,
  ContextMessage,
  ManageContextConfig,
  ManageContextResult,
  TokenEstimator,
  ToolOutputConfig,
} from "./types.js";
import { createDefaultEstimator } from "./token-estimator.js";
import { normalizeMessages } from "./messages.js";
import { applyToolOutputPolicy } from "./rule-based-compressor.js";
import { applySegments, buildSummaryMessage, validateSegments } from "./segments.js";
import { createTranscript } from "./transcript.js";

const DEFAULT_COMPRESSION_THRESHOLD = 0.8;
const DEFAULT_PROTECTED_TAIL_COUNT = 4;

interface CompressionCandidate {
  messages: ContextMessage[];
  rangeStart: number;
  rangeEnd: number;
}

function normalizeToolOutputConfig(
  toolOutput?: ToolOutputConfig
): Required<Pick<ToolOutputConfig, "defaultPolicy" | "maxTokens" | "recentFullCount">> & {
  toolOverrides: Record<string, "keep" | "truncate" | "remove">;
} {
  return {
    defaultPolicy: toolOutput?.defaultPolicy ?? "truncate",
    maxTokens: toolOutput?.maxTokens ?? 200,
    recentFullCount: toolOutput?.recentFullCount ?? 2,
    toolOverrides: toolOutput?.toolOverrides ?? {},
  };
}

function extractToolCallIds(message: ContextMessage): string[] {
  return message.entryType === "tool-call" && message.toolCallId ? [message.toolCallId] : [];
}

function extractToolResultIds(message: ContextMessage): string[] {
  return message.entryType === "tool-result" && message.toolCallId ? [message.toolCallId] : [];
}

function adjustSplitIndexForToolAdjacency(messages: ContextMessage[], splitIndex: number): number {
  let adjustedSplitIndex = splitIndex;

  while (adjustedSplitIndex > 0) {
    const toolCallsInTail = new Set<string>();
    const toolResultsInTail = new Set<string>();

    for (let i = adjustedSplitIndex; i < messages.length; i++) {
      for (const toolCallId of extractToolCallIds(messages[i])) {
        toolCallsInTail.add(toolCallId);
      }
      for (const toolCallId of extractToolResultIds(messages[i])) {
        toolResultsInTail.add(toolCallId);
      }
    }

    const hasDanglingToolResult = Array.from(toolResultsInTail).some(
      (toolCallId) => !toolCallsInTail.has(toolCallId)
    );

    if (!hasDanglingToolResult) {
      break;
    }

    adjustedSplitIndex--;
  }

  return adjustedSplitIndex;
}

function adjustTailSplitForToolAdjacency(messages: ContextMessage[], requestedTailCount: number): number {
  const splitIndex = Math.max(messages.length - requestedTailCount, 0);
  return adjustSplitIndexForToolAdjacency(messages, splitIndex);
}

function createFallbackNotice(): ContextMessage {
  return {
    id: "fallback:truncated",
    role: "user",
    entryType: "summary",
    content: "[Earlier conversation truncated to fit token budget]",
  };
}

function selectFittingConversationTail(
  messages: ContextMessage[],
  availableTokens: number,
  estimator: TokenEstimator
): ContextMessage[] {
  if (availableTokens <= 0 || messages.length === 0) {
    return [];
  }

  let bestStartIndex = messages.length;

  for (let i = messages.length; i >= 0; i--) {
    const candidateStartIndex = adjustSplitIndexForToolAdjacency(messages, i);
    const candidateMessages = messages.slice(candidateStartIndex);
    if (estimator.estimateMessages(candidateMessages) <= availableTokens) {
      bestStartIndex = candidateStartIndex;
    }
  }

  return messages.slice(bestStartIndex);
}

function enforceTokenBudget(
  systemMessages: ContextMessage[],
  conversationMessages: ContextMessage[],
  maxTokens: number,
  estimator: TokenEstimator
): ContextMessage[] {
  const systemTokens = estimator.estimateMessages(systemMessages);
  const availableConversationTokens = maxTokens - systemTokens;

  if (availableConversationTokens <= 0) {
    return [...systemMessages];
  }

  let fittedConversation = selectFittingConversationTail(
    conversationMessages,
    availableConversationTokens,
    estimator
  );

  if (fittedConversation.length === conversationMessages.length) {
    return [...systemMessages, ...fittedConversation];
  }

  const notice = createFallbackNotice();
  const noticeTokens = estimator.estimateMessage(notice);

  if (noticeTokens <= availableConversationTokens) {
    const budgetAfterNotice = availableConversationTokens - noticeTokens;
    fittedConversation = selectFittingConversationTail(conversationMessages, budgetAfterNotice, estimator);
    return [...systemMessages, notice, ...fittedConversation];
  }

  return [...systemMessages, ...fittedConversation];
}

function splitSystemMessages(messages: ContextMessage[]): {
  systemMessages: ContextMessage[];
  conversationMessages: ContextMessage[];
} {
  const systemMessages: ContextMessage[] = [];
  const conversationMessages: ContextMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemMessages.push(message);
      continue;
    }

    conversationMessages.push(message);
  }

  return { systemMessages, conversationMessages };
}

function dedupeSegments(segments: CompressionSegment[]): CompressionSegment[] {
  const deduped = new Map<string, CompressionSegment>();

  for (const segment of segments) {
    deduped.set(`${segment.fromId}:${segment.toId}`, segment);
  }

  return Array.from(deduped.values());
}

function sortSegmentsByConversation(
  messages: ContextMessage[],
  segments: CompressionSegment[]
): CompressionSegment[] {
  return [...segments].sort((left, right) => {
    const leftIndex = messages.findIndex((message) => message.id === left.fromId);
    const rightIndex = messages.findIndex((message) => message.id === right.fromId);
    return leftIndex - rightIndex;
  });
}

function selectCompressionCandidate(
  conversationMessages: ContextMessage[],
  protectedTailCount: number
): CompressionCandidate | null {
  if (conversationMessages.length === 0) {
    return null;
  }

  const tailCount = Math.min(protectedTailCount, conversationMessages.length);
  const tailStartIndex = adjustTailSplitForToolAdjacency(conversationMessages, tailCount);
  if (tailStartIndex <= 0) {
    return null;
  }

  const body = conversationMessages.slice(0, tailStartIndex);
  let rangeStart = 0;

  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].entryType === "summary") {
      rangeStart = i + 1;
      break;
    }
  }

  if (rangeStart >= body.length) {
    return null;
  }

  const candidate = body.slice(rangeStart);
  if (candidate.length === 0 || candidate.some((message) => message.entryType === "summary")) {
    return null;
  }

  return {
    messages: candidate,
    rangeStart,
    rangeEnd: tailStartIndex - 1,
  };
}

function summarizeSegmentModifications(
  allMessages: ContextMessage[],
  newSegments: CompressionSegment[],
  estimator: TokenEstimator
): CompressionModification[] {
  return newSegments.map((segment) => {
    const fromIndex = allMessages.findIndex((message) => message.id === segment.fromId);
    const toIndex = allMessages.findIndex((message) => message.id === segment.toId);
    const coveredMessages = fromIndex >= 0 && toIndex >= fromIndex
      ? allMessages.slice(fromIndex, toIndex + 1)
      : [];
    const summaryMessage = buildSummaryMessage(segment);

    return {
      type: "conversation-summarized",
      messageIndex: Math.max(fromIndex, 0),
      originalTokens: estimator.estimateMessages(coveredMessages),
      compressedTokens: estimator.estimateMessage(summaryMessage),
      originalText: coveredMessages.map((message) => message.content).join("\n"),
    };
  });
}

export async function manageContext(config: ManageContextConfig): Promise<ManageContextResult> {
  const estimator = config.estimator ?? createDefaultEstimator();
  const compressionThreshold = config.compressionThreshold ?? DEFAULT_COMPRESSION_THRESHOLD;
  const protectedTailCount = config.protectedTailCount ?? DEFAULT_PROTECTED_TAIL_COUNT;
  const normalizedMessages = normalizeMessages(config.messages);
  const originalTokenEstimate = estimator.estimateMessages(normalizedMessages);

  const toolPolicyResult = await applyToolOutputPolicy(normalizedMessages, {
    estimator,
    toolOutput: normalizeToolOutputConfig(config.toolOutput),
    onToolOutputTruncated: config.onToolOutputTruncated,
  });

  const existingSegments = dedupeSegments(config.existingSegments ?? []);
  const { systemMessages, conversationMessages } = splitSystemMessages(toolPolicyResult.messages);
  const existingSegmentValidation = validateSegments(conversationMessages, existingSegments);
  if (!existingSegmentValidation.valid) {
    throw new Error(`Invalid existing segments: ${existingSegmentValidation.error}`);
  }

  const postToolPolicyTokenEstimate = toolPolicyResult.tokenEstimate;
  let appliedSegments = sortSegmentsByConversation(conversationMessages, existingSegments);
  let newSegments: CompressionSegment[] = [];
  let modifications = [...toolPolicyResult.modifications];

  const conversationWithExistingSegments = applySegments(conversationMessages, appliedSegments);
  const postExistingSegmentsTokenEstimate = estimator.estimateMessages([
    ...systemMessages,
    ...conversationWithExistingSegments,
  ]);

  if (
    config.segmentGenerator &&
    postExistingSegmentsTokenEstimate > Math.floor(config.maxTokens * compressionThreshold)
  ) {
    const candidate = selectCompressionCandidate(conversationWithExistingSegments, protectedTailCount);

    if (candidate) {
      const transcript = createTranscript(candidate.messages, {
        renderer: config.transcriptRenderer,
      });
      const outsideCandidate = [
        ...systemMessages,
        ...conversationWithExistingSegments.slice(0, candidate.rangeStart),
        ...conversationWithExistingSegments.slice(candidate.rangeEnd + 1),
      ];
      const targetTokens = Math.max(
        1,
        Math.floor(config.maxTokens * compressionThreshold) - estimator.estimateMessages(outsideCandidate)
      );
      const generatedSegments = await config.segmentGenerator.generate({
        transcript,
        targetTokens,
        messages: candidate.messages,
        previousSegments: appliedSegments,
      });

      const generatedSegmentValidation = validateSegments(candidate.messages, generatedSegments, {
        requireFullCoverage: true,
      });
      if (!generatedSegmentValidation.valid) {
        throw new Error(`Invalid generated segments: ${generatedSegmentValidation.error}`);
      }

      newSegments = generatedSegments.map((segment) => ({
        ...segment,
        createdAt: segment.createdAt ?? Date.now(),
      }));
      appliedSegments = sortSegmentsByConversation(
        conversationMessages,
        dedupeSegments([...appliedSegments, ...newSegments])
      );
      modifications = modifications.concat(
        summarizeSegmentModifications(conversationMessages, newSegments, estimator)
      );
    }
  }

  const conversationWithAllSegments = applySegments(conversationMessages, appliedSegments);
  const preBudgetMessages = [...systemMessages, ...conversationWithAllSegments];
  const postSegmentTokenEstimate = estimator.estimateMessages(preBudgetMessages);
  const finalMessages = enforceTokenBudget(systemMessages, conversationWithAllSegments, config.maxTokens, estimator);
  const finalTokenEstimate = estimator.estimateMessages(finalMessages);

  return {
    messages: finalMessages,
    appliedSegments,
    newSegments,
    modifications,
    stats: {
      originalTokenEstimate,
      postToolPolicyTokenEstimate,
      postSegmentTokenEstimate,
      finalTokenEstimate,
    },
  };
}
