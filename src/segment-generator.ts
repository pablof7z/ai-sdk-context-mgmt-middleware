import type { CompressionSegment, SegmentGenerationInput, SegmentGenerator } from "./types.js";

export interface CreateSegmentGeneratorConfig {
  generate: (prompt: string) => Promise<string>;
  promptTemplate?: string;
  buildPrompt?: (input: SegmentGenerationInput) => string;
  parse?: (response: string, input: SegmentGenerationInput) => CompressionSegment[];
}

export interface CreateObjectSegmentGeneratorConfig {
  generate: (
    prompt: string,
    input: SegmentGenerationInput
  ) => Promise<
    | { segments: Array<Record<string, unknown>> }
    | Array<Record<string, unknown>>
  >;
  promptTemplate?: string;
  buildPrompt?: (input: SegmentGenerationInput) => string;
  parse?: (
    response: { segments: Array<Record<string, unknown>> } | Array<Record<string, unknown>>,
    input: SegmentGenerationInput
  ) => CompressionSegment[];
}

const DEFAULT_PREVIOUS_SEGMENT_CONTEXT_LIMIT = 3;

export const DEFAULT_SEGMENT_PROMPT_TEMPLATE = `You compress conversation history into 1 or more replacement segments.
Return strict JSON with this shape:
{"segments":[{"fromId":"<id>","toId":"<id>","compressed":"<summary>"}]}

Rules:
- Use only transcript ids that appear in the transcript.
- Cover the candidate range exactly with contiguous, non-overlapping segments.
- Preserve concrete facts, decisions, unresolved work, and tool findings.
- Do not include markdown fences or explanatory text.

{{previousSegments}}Target replacement budget: {{targetTokens}} tokens.
Transcript ids run from {{firstId}} to {{lastId}}.

Transcript:
{{transcript}}`;

function buildPreviousSegmentContext(input: SegmentGenerationInput): string {
  if (input.previousSegments.length === 0) {
    return "";
  }

  const recentSegments = input.previousSegments.slice(-DEFAULT_PREVIOUS_SEGMENT_CONTEXT_LIMIT);
  const lines = recentSegments.map(
    (segment, index) =>
      `[Previous summary ${index + 1}] ${segment.fromId}..${segment.toId}: ${segment.compressed}`
  );

  return `Recent compressed context:\n${lines.join("\n")}\n\n`;
}

export function buildDefaultSegmentPrompt(
  input: SegmentGenerationInput,
  promptTemplate = DEFAULT_SEGMENT_PROMPT_TEMPLATE
): string {
  return promptTemplate
    .replace("{{previousSegments}}", buildPreviousSegmentContext(input))
    .replace("{{targetTokens}}", String(input.targetTokens))
    .replace("{{firstId}}", input.transcript.firstId ?? "none")
    .replace("{{lastId}}", input.transcript.lastId ?? "none")
    .replace("{{transcript}}", input.transcript.text);
}

function mapId(id: string, shortIdMap: Map<string, string>): string {
  return shortIdMap.get(id) ?? id;
}

function normalizeSegments(
  response: { segments: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const segments = Array.isArray(response) ? response : response.segments;

  if (!Array.isArray(segments)) {
    throw new Error("Segment generator response must contain a segments array");
  }

  return segments;
}

function parseSegments(
  response: { segments: Array<Record<string, unknown>> } | Array<Record<string, unknown>>,
  input: SegmentGenerationInput
): CompressionSegment[] {
  const segments = normalizeSegments(response);

  return segments.map((segment) => {
    if (
      !segment ||
      typeof segment.fromId !== "string" ||
      typeof segment.toId !== "string" ||
      typeof segment.compressed !== "string"
    ) {
      throw new Error("Each segment must include string fromId, toId, and compressed fields");
    }

    return {
      fromId: mapId(segment.fromId, input.transcript.shortIdMap),
      toId: mapId(segment.toId, input.transcript.shortIdMap),
      compressed: segment.compressed.trim(),
      ...(typeof segment.createdAt === "number" ? { createdAt: segment.createdAt } : {}),
      ...(segment.metadata && typeof segment.metadata === "object"
        ? { metadata: segment.metadata as Record<string, unknown> }
        : {}),
    } satisfies CompressionSegment;
  });
}

function parseDefaultResponse(response: string, input: SegmentGenerationInput): CompressionSegment[] {
  return parseSegments(JSON.parse(response), input);
}

export function createSegmentGenerator(config: CreateSegmentGeneratorConfig): SegmentGenerator {
  return {
    async generate(input: SegmentGenerationInput): Promise<CompressionSegment[]> {
      const prompt = config.buildPrompt
        ? config.buildPrompt(input)
        : buildDefaultSegmentPrompt(input, config.promptTemplate);
      const response = await config.generate(prompt);
      const parser = config.parse ?? parseDefaultResponse;
      return parser(response, input);
    },
  };
}

export function createObjectSegmentGenerator(
  config: CreateObjectSegmentGeneratorConfig
): SegmentGenerator {
  return {
    async generate(input: SegmentGenerationInput): Promise<CompressionSegment[]> {
      const prompt = config.buildPrompt
        ? config.buildPrompt(input)
        : buildDefaultSegmentPrompt(input, config.promptTemplate);
      const response = await config.generate(prompt, input);
      const parser = config.parse ?? parseSegments;
      return parser(response, input);
    },
  };
}
