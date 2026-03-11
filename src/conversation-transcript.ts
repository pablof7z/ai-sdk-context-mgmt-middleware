import { createTranscript, defaultTranscriptRenderer } from "./transcript.js";
import type {
  ConversationRecord,
  TranscriptBuildOptions,
  TranscriptBuildResult,
  TranscriptBuilder,
} from "./public-types.js";
import { recordsToContextMessages } from "./public-mappers.js";

export const defaultTranscriptBuilder: TranscriptBuilder = {
  build(records: ConversationRecord[], options?: TranscriptBuildOptions): TranscriptBuildResult {
    const transcript = createTranscript(recordsToContextMessages(records), {
      renderer: defaultTranscriptRenderer,
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

export function buildTranscript(
  records: ConversationRecord[],
  options?: TranscriptBuildOptions & { builder?: TranscriptBuilder }
): TranscriptBuildResult {
  const builder = options?.builder ?? defaultTranscriptBuilder;
  return builder.build(records, options);
}
