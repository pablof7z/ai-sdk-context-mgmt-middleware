import type { ConversationRecord, SummarySpan } from "./public-types.js";
import type { TokenEstimator } from "./types.js";
import { recordsToContextMessages } from "./public-mappers.js";
import { createDefaultEstimator } from "./token-estimator.js";

function computeTokenAwarePreservedTailCount(
  records: ConversationRecord[],
  maxTokens: number,
  estimator: TokenEstimator
): number {
  const messages = recordsToContextMessages(records);
  let accumulatedTokens = 0;
  let count = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageTokens = estimator.estimateMessage(messages[index]);
    if (accumulatedTokens + messageTokens > maxTokens && count > 0) {
      break;
    }

    accumulatedTokens += messageTokens;
    count += 1;
  }

  return Math.max(1, count);
}

function extendToCompletedToolExchanges(
  records: ConversationRecord[],
  initialEndIndex: number
): number {
  let endIndex = initialEndIndex;
  const pendingToolCalls = new Set<string>();

  for (let index = 0; index <= endIndex; index += 1) {
    const record = records[index];
    if (record.kind === "tool-call" && record.toolCallId) {
      pendingToolCalls.add(record.toolCallId);
      continue;
    }

    if (record.kind === "tool-result" && record.toolCallId) {
      pendingToolCalls.delete(record.toolCallId);
    }
  }

  if (pendingToolCalls.size === 0) {
    return endIndex;
  }

  for (let index = endIndex + 1; index < records.length; index += 1) {
    const record = records[index];
    if (record.kind === "tool-result" && record.toolCallId && pendingToolCalls.has(record.toolCallId)) {
      pendingToolCalls.delete(record.toolCallId);
      endIndex = index;
      if (pendingToolCalls.size === 0) {
        break;
      }
      continue;
    }

    break;
  }

  return endIndex;
}

export function buildLastResortSummarySpan(config: {
  records: ConversationRecord[];
  maxTokens: number;
  preservedTailCount: number;
  estimator?: TokenEstimator;
}): SummarySpan | undefined {
  const { records } = config;
  if (records.length === 0) {
    return undefined;
  }

  const estimator = config.estimator ?? createDefaultEstimator();
  const tokenAwarePreservedTailCount = computeTokenAwarePreservedTailCount(
    records,
    config.maxTokens,
    estimator
  );
  const effectivePreservedTailCount = Math.min(
    config.preservedTailCount,
    tokenAwarePreservedTailCount
  );

  if (records.length <= effectivePreservedTailCount) {
    return undefined;
  }

  const truncateCount = records.length - effectivePreservedTailCount;
  const endIndex = extendToCompletedToolExchanges(records, truncateCount - 1);

  if (endIndex < 0 || endIndex >= records.length) {
    return undefined;
  }

  return {
    startRecordId: records[0].id,
    endRecordId: records[endIndex].id,
    summary: `[Truncated ${endIndex + 1} earlier records after summarization failed]`,
    createdAt: Date.now(),
    metadata: {
      strategy: "last-resort-truncate",
    },
  };
}
