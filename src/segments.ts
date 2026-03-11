import type {
  CompressionSegment,
  ContextMessage,
  SegmentValidationOptions,
  ValidationResult,
} from "./types.js";

const SEGMENT_METADATA_KEY = "segment";

function getComparableId(message: ContextMessage): string {
  return message.sourceRecordId ?? message.id;
}

export function buildSummaryMessage(segment: CompressionSegment): ContextMessage {
  return {
    id: `segment:${segment.fromId}:${segment.toId}`,
    role: "user",
    entryType: "summary",
    content: `[Compressed history]\n${segment.compressed}`,
    metadata: {
      [SEGMENT_METADATA_KEY]: segment,
    },
  };
}

function sortSegmentsByMessageOrder(
  messages: ContextMessage[],
  segments: CompressionSegment[]
): CompressionSegment[] {
  return [...segments].sort((left, right) => {
    const leftIndex = messages.findIndex((message) => getComparableId(message) === left.fromId);
    const rightIndex = messages.findIndex((message) => getComparableId(message) === right.fromId);
    return leftIndex - rightIndex;
  });
}

export function validateSegments(
  messages: ContextMessage[],
  segments: CompressionSegment[],
  options?: SegmentValidationOptions
): ValidationResult {
  if (segments.length === 0) {
    return { valid: true };
  }

  const sortedSegments = sortSegmentsByMessageOrder(messages, segments);
  let previousToIndex = -1;

  for (let i = 0; i < sortedSegments.length; i++) {
    const segment = sortedSegments[i];
    const fromIndex = messages.findIndex((message) => getComparableId(message) === segment.fromId);
    const toIndex = messages.findIndex((message) => getComparableId(message) === segment.toId);

    if (fromIndex < 0) {
      return { valid: false, error: `fromId ${segment.fromId} not found` };
    }

    if (toIndex < 0) {
      return { valid: false, error: `toId ${segment.toId} not found` };
    }

    if (fromIndex > toIndex) {
      return { valid: false, error: `Segment ${i}: fromId comes after toId` };
    }

    if (fromIndex <= previousToIndex) {
      return { valid: false, error: `Segment ${i}: overlaps a previous segment` };
    }

    if (options?.requireFullCoverage && previousToIndex >= 0 && fromIndex !== previousToIndex + 1) {
      return { valid: false, error: `Segment ${i}: gap detected in full-coverage validation` };
    }

    previousToIndex = toIndex;
  }

  if (options?.requireFullCoverage) {
    const firstSegment = sortedSegments[0];
    const lastSegment = sortedSegments[sortedSegments.length - 1];
    if (messages[0] && firstSegment.fromId !== getComparableId(messages[0])) {
      return {
        valid: false,
        error: `First segment must start at range beginning (expected ${getComparableId(messages[0])}, got ${firstSegment.fromId})`,
      };
    }

    if (messages[messages.length - 1] && lastSegment.toId !== getComparableId(messages[messages.length - 1])) {
      return {
        valid: false,
        error: `Last segment must end at range end (expected ${getComparableId(messages[messages.length - 1])}, got ${lastSegment.toId})`,
      };
    }
  }

  return { valid: true };
}

export function applySegments(
  messages: ContextMessage[],
  segments: CompressionSegment[]
): ContextMessage[] {
  if (segments.length === 0) {
    return [...messages];
  }

  const sortedSegments = sortSegmentsByMessageOrder(messages, segments);
  const result: ContextMessage[] = [];
  let currentIndex = 0;

  for (const segment of sortedSegments) {
    const fromIndex = messages.findIndex((message) => getComparableId(message) === segment.fromId);
    const toIndex = messages.findIndex((message) => getComparableId(message) === segment.toId);

    if (fromIndex < 0 || toIndex < 0) {
      continue;
    }

    while (currentIndex < fromIndex) {
      result.push(messages[currentIndex]);
      currentIndex++;
    }

    result.push(buildSummaryMessage(segment));
    currentIndex = toIndex + 1;
  }

  while (currentIndex < messages.length) {
    result.push(messages[currentIndex]);
    currentIndex++;
  }

  return result;
}
