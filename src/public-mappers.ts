import type {
  CompressionSegment,
  ContextCompressionMessage,
  ContextMessage,
  SegmentGenerator,
  SegmentStore,
  TranscriptRenderResult,
  TranscriptRenderer,
} from "./types.js";
import type {
  ConversationRecord,
  PromptMessage,
  Summarizer,
  SummarySpan,
  SummaryStore,
  TranscriptBuildResult,
  TranscriptBuilder,
} from "./public-types.js";
import { contextMessagesToMessages, messagesToContextMessages, normalizeMessages } from "./messages.js";

export function recordsToContextMessages(records: ConversationRecord[]): ContextMessage[] {
  return normalizeMessages(records.map((record) => ({
    id: record.id,
    role: record.role,
    entryType: record.kind,
    content: record.content,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    timestamp: record.timestamp,
    attributes: record.attributes,
    metadata: record.metadata,
  })));
}

export function contextMessagesToRecords(messages: ContextMessage[]): ConversationRecord[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    kind: message.entryType,
    content: message.content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    timestamp: message.timestamp,
    attributes: message.attributes,
    metadata: message.metadata,
  }));
}

export function promptMessagesToContextMessages(messages: PromptMessage[]): ContextMessage[] {
  return messagesToContextMessages(messages as ContextCompressionMessage[]);
}

export function contextMessagesToPromptMessages(messages: ContextMessage[]): PromptMessage[] {
  return contextMessagesToMessages(messages) as PromptMessage[];
}

export function summarySpansToCompressionSegments(summarySpans: SummarySpan[]): CompressionSegment[] {
  return summarySpans.map((summarySpan) => ({
    fromId: summarySpan.startRecordId,
    toId: summarySpan.endRecordId,
    compressed: summarySpan.summary,
    createdAt: summarySpan.createdAt,
    metadata: summarySpan.metadata,
  }));
}

export function compressionSegmentsToSummarySpans(segments: CompressionSegment[]): SummarySpan[] {
  return segments.map((segment) => ({
    startRecordId: segment.fromId,
    endRecordId: segment.toId,
    summary: segment.compressed,
    createdAt: segment.createdAt,
    metadata: segment.metadata,
  }));
}

export function createTranscriptRendererAdapter(
  transcriptBuilder: TranscriptBuilder | undefined
): TranscriptRenderer | undefined {
  if (!transcriptBuilder) {
    return undefined;
  }

  return {
    render(messages, options): TranscriptRenderResult {
      const transcript = transcriptBuilder.build(contextMessagesToRecords(messages), {
        shortIdLength: options?.shortIdLength,
      });

      return {
        text: transcript.text,
        shortIdMap: transcript.shortIdMap,
        firstId: transcript.firstTranscriptId,
        lastId: transcript.lastTranscriptId,
      };
    },
  };
}

export function createTranscriptBuilderAdapter(
  transcriptRenderer: TranscriptRenderer
): TranscriptBuilder {
  return {
    build(records, options): TranscriptBuildResult {
      const transcript = transcriptRenderer.render(recordsToContextMessages(records), {
        shortIdLength: options?.shortIdLength,
      });

      return {
        text: transcript.text,
        shortIdMap: transcript.shortIdMap,
        firstTranscriptId: transcript.firstId,
        lastTranscriptId: transcript.lastId,
      };
    },
  };
}

export function createSummarizerAdapter(summarizer: Summarizer | undefined): SegmentGenerator | undefined {
  if (!summarizer) {
    return undefined;
  }

  return {
    async generate(input) {
      const summarySpans = await summarizer.summarize({
        transcript: {
          text: input.transcript.text,
          shortIdMap: input.transcript.shortIdMap,
          firstTranscriptId: input.transcript.firstId,
          lastTranscriptId: input.transcript.lastId,
        },
        targetTokens: input.targetTokens,
        records: contextMessagesToRecords(input.messages),
        previousSummarySpans: compressionSegmentsToSummarySpans(input.previousSegments),
      });

      return summarySpansToCompressionSegments(summarySpans);
    },
  };
}

export function createSummaryStoreAdapter(
  summaryStore: SummaryStore | undefined,
  existingSummarySpans: SummarySpan[] | undefined
): SegmentStore | undefined {
  if (!summaryStore && !existingSummarySpans) {
    return undefined;
  }

  return {
    async load(conversationKey) {
      const stored = summaryStore ? await summaryStore.load(conversationKey) : [];
      const merged = [...(stored ?? []), ...(existingSummarySpans ?? [])];
      return summarySpansToCompressionSegments(dedupeSummarySpans(merged));
    },
    save: summaryStore?.save
      ? async (conversationKey, segments) => {
          await summaryStore.save!(conversationKey, compressionSegmentsToSummarySpans(segments));
        }
      : undefined,
    append: summaryStore?.append
      ? async (conversationKey, segments) => {
          await summaryStore.append!(conversationKey, compressionSegmentsToSummarySpans(segments));
        }
      : undefined,
  };
}

export function dedupeSummarySpans(summarySpans: SummarySpan[]): SummarySpan[] {
  const deduped = new Map<string, SummarySpan>();

  for (const summarySpan of summarySpans) {
    deduped.set(`${summarySpan.startRecordId}:${summarySpan.endRecordId}`, summarySpan);
  }

  return Array.from(deduped.values());
}
