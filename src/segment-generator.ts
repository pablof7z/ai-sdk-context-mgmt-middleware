import type { CompressionSegment, SegmentGenerationInput, SegmentGenerator } from "./types.js";

export interface CreateSegmentGeneratorConfig {
  generate: (prompt: string) => Promise<string>;
  buildPrompt?: (input: SegmentGenerationInput) => string;
  parse?: (response: string, input: SegmentGenerationInput) => CompressionSegment[];
}

const DEFAULT_PROMPT_TEMPLATE = `You compress conversation history into 1 or more replacement segments.
Return strict JSON with this shape:
{"segments":[{"fromId":"<id>","toId":"<id>","compressed":"<summary>"}]}

Rules:
- Use only transcript ids that appear in the transcript.
- Cover the candidate range exactly with contiguous, non-overlapping segments.
- Preserve concrete facts, decisions, unresolved work, and tool findings.
- Do not include markdown fences or explanatory text.

Target replacement budget: {{targetTokens}} tokens.
Transcript ids run from {{firstId}} to {{lastId}}.

Transcript:
{{transcript}}`;

function buildDefaultPrompt(input: SegmentGenerationInput): string {
  return DEFAULT_PROMPT_TEMPLATE
    .replace("{{targetTokens}}", String(input.targetTokens))
    .replace("{{firstId}}", input.transcript.firstId ?? "none")
    .replace("{{lastId}}", input.transcript.lastId ?? "none")
    .replace("{{transcript}}", input.transcript.text);
}

function mapId(id: string, shortIdMap: Map<string, string>): string {
  return shortIdMap.get(id) ?? id;
}

function parseDefaultResponse(response: string, input: SegmentGenerationInput): CompressionSegment[] {
  const parsed = JSON.parse(response);
  const segments = Array.isArray(parsed) ? parsed : parsed.segments;

  if (!Array.isArray(segments)) {
    throw new Error("Segment generator response must contain a segments array");
  }

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
    } satisfies CompressionSegment;
  });
}

export function createSegmentGenerator(config: CreateSegmentGeneratorConfig): SegmentGenerator {
  return {
    async generate(input: SegmentGenerationInput): Promise<CompressionSegment[]> {
      const prompt = config.buildPrompt ? config.buildPrompt(input) : buildDefaultPrompt(input);
      const response = await config.generate(prompt);
      const parser = config.parse ?? parseDefaultResponse;
      return parser(response, input);
    },
  };
}
