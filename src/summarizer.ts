import type {
  Summarizer,
  SummarizerInput,
  SummarySpan,
} from "./public-types.js";

export interface CreateSummarizerConfig {
  summarize: (prompt: string) => Promise<string>;
  promptTemplate?: string;
  buildPrompt?: (input: SummarizerInput) => string;
  parse?: (
    response: string,
    input: SummarizerInput
  ) => Awaited<ReturnType<Summarizer["summarize"]>>;
}

const DEFAULT_PREVIOUS_SUMMARY_CONTEXT_LIMIT = 3;

export const DEFAULT_SUMMARIZER_PROMPT_TEMPLATE = `You summarize canonical conversation history into 1 or more replacement summary spans.
Return strict JSON with this shape:
[{"startId":"<id>","endId":"<id>","summary":"<summary>"}]

Rules:
- Use only transcript ids that appear in the transcript.
- Cover the candidate range exactly with contiguous, non-overlapping spans.
- Preserve attribution, routing, concrete facts, decisions, unresolved work, tool findings, and outcomes.
- The first span must start at id "{{firstId}}" and the last span must end at id "{{lastId}}".
- Keep summaries concise but specific.
- Do not include markdown fences or explanatory text.

{{previousSummarySpans}}Target replacement budget: {{targetTokens}} tokens.

Transcript:
{{transcript}}`;

function buildPreviousSummaryContext(input: SummarizerInput): string {
  if (input.previousSummarySpans.length === 0) {
    return "";
  }

  const recentSummarySpans = input.previousSummarySpans.slice(-DEFAULT_PREVIOUS_SUMMARY_CONTEXT_LIMIT);
  const lines = recentSummarySpans.map(
    (summarySpan, index) =>
      `[Previous summary ${index + 1}] ${summarySpan.startRecordId}..${summarySpan.endRecordId}: ${summarySpan.summary}`
  );

  return `Recent history summaries:\n${lines.join("\n")}\n\n`;
}

export function buildDefaultSummarizerPrompt(
  input: SummarizerInput,
  promptTemplate = DEFAULT_SUMMARIZER_PROMPT_TEMPLATE
): string {
  const firstTranscriptId = findTranscriptId(
    input.transcript.firstTranscriptId,
    input.transcript.shortIdMap
  );
  const lastTranscriptId = findTranscriptId(
    input.transcript.lastTranscriptId,
    input.transcript.shortIdMap
  );

  return promptTemplate
    .replace("{{previousSummarySpans}}", buildPreviousSummaryContext(input))
    .replace("{{targetTokens}}", String(input.targetTokens))
    .replace("{{firstId}}", firstTranscriptId ?? "none")
    .replace("{{lastId}}", lastTranscriptId ?? "none")
    .replace("{{transcript}}", input.transcript.text);
}

function mapId(id: string, shortIdMap: Map<string, string>): string {
  return shortIdMap.get(id) ?? id;
}

function findTranscriptId(
  recordIdOrTranscriptId: string | null,
  shortIdMap: Map<string, string>
): string | null {
  if (!recordIdOrTranscriptId) {
    return null;
  }

  for (const [transcriptId, recordId] of shortIdMap.entries()) {
    if (recordId === recordIdOrTranscriptId) {
      return transcriptId;
    }
  }

  return recordIdOrTranscriptId;
}

function normalizeSummarySpanResponse(
  response: unknown
): Array<Record<string, unknown>> {
  if (Array.isArray(response)) {
    return response as Array<Record<string, unknown>>;
  }

  if (
    response &&
    typeof response === "object" &&
    "summarySpans" in response &&
    Array.isArray((response as { summarySpans: unknown }).summarySpans)
  ) {
    return (response as { summarySpans: Array<Record<string, unknown>> }).summarySpans;
  }

  if (
    response &&
    typeof response === "object" &&
    "segments" in response &&
    Array.isArray((response as { segments: unknown }).segments)
  ) {
    return (response as { segments: Array<Record<string, unknown>> }).segments;
  }

  throw new Error("Summarizer response must be an array or an object containing summarySpans");
}

export function parseDefaultSummarizerResponse(
  response: string,
  input: SummarizerInput
): SummarySpan[] {
  const parsed = JSON.parse(response) as unknown;
  const summarySpans = normalizeSummarySpanResponse(parsed);

  return summarySpans.map((summarySpan) => {
    const startId = typeof summarySpan.startId === "string"
      ? summarySpan.startId
      : typeof summarySpan.fromId === "string"
        ? summarySpan.fromId
        : undefined;
    const endId = typeof summarySpan.endId === "string"
      ? summarySpan.endId
      : typeof summarySpan.toId === "string"
        ? summarySpan.toId
        : undefined;
    const summary = typeof summarySpan.summary === "string"
      ? summarySpan.summary
      : typeof summarySpan.compressed === "string"
        ? summarySpan.compressed
        : undefined;

    if (!startId || !endId || !summary) {
      throw new Error("Each summary span must include string startId, endId, and summary fields");
    }

    return {
      startRecordId: mapId(startId, input.transcript.shortIdMap),
      endRecordId: mapId(endId, input.transcript.shortIdMap),
      summary: summary.trim(),
      ...(typeof summarySpan.createdAt === "number" ? { createdAt: summarySpan.createdAt } : {}),
      ...(summarySpan.metadata && typeof summarySpan.metadata === "object"
        ? { metadata: summarySpan.metadata as Record<string, unknown> }
        : {}),
    } satisfies SummarySpan;
  });
}

export function createSummarizer(config: CreateSummarizerConfig): Summarizer {
  return {
    async summarize(input) {
      const prompt = config.buildPrompt
        ? config.buildPrompt(input)
        : buildDefaultSummarizerPrompt(input, config.promptTemplate);
      const response = await config.summarize(prompt);
      const parser = config.parse ?? parseDefaultSummarizerResponse;
      return parser(response, input);
    },
  };
}
