import type {
  ContextMessage,
  TranscriptRenderOptions,
  TranscriptRenderResult,
  TranscriptRenderer,
} from "./types.js";

const DEFAULT_SHORT_ID_LENGTH = 8;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function createShortIdMap(messages: ContextMessage[], shortIdLength: number): Map<string, string> {
  const usedShortIds = new Set<string>();
  const shortIdMap = new Map<string, string>();

  for (const message of messages) {
    const base = message.id.slice(0, shortIdLength) || "msg";
    let candidate = base;
    let suffix = 2;

    while (usedShortIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix++;
    }

    usedShortIds.add(candidate);
    shortIdMap.set(candidate, message.id);
  }

  return shortIdMap;
}

export const defaultTranscriptRenderer: TranscriptRenderer = {
  render(messages: ContextMessage[], options?: TranscriptRenderOptions): TranscriptRenderResult {
    const shortIdLength = options?.shortIdLength ?? DEFAULT_SHORT_ID_LENGTH;
    const shortIdMap = createShortIdMap(messages, shortIdLength);
    const fullToShortId = new Map(Array.from(shortIdMap.entries()).map(([shortId, fullId]) => [fullId, shortId]));

    const lines = ["<conversation>"];

    for (const message of messages) {
      const shortId = fullToShortId.get(message.id) ?? message.id;
      const attrs = [
        `id=\"${escapeXml(shortId)}\"`,
        `role=\"${escapeXml(message.role)}\"`,
        `type=\"${escapeXml(message.entryType)}\"`,
      ];

      if (message.toolCallId) {
        attrs.push(`toolCallId=\"${escapeXml(message.toolCallId)}\"`);
      }
      if (message.toolName) {
        attrs.push(`toolName=\"${escapeXml(message.toolName)}\"`);
      }
      if (message.timestamp !== undefined) {
        attrs.push(`timestamp=\"${escapeXml(String(message.timestamp))}\"`);
      }
      if (message.attributes) {
        for (const [key, value] of Object.entries(message.attributes)) {
          attrs.push(`${escapeXml(key)}=\"${escapeXml(value)}\"`);
        }
      }

      lines.push(`  <message ${attrs.join(" ")}>${escapeXml(message.content)}</message>`);
    }

    lines.push("</conversation>");

    const firstId = messages.length > 0 ? fullToShortId.get(messages[0].id) ?? null : null;
    const lastId = messages.length > 0 ? fullToShortId.get(messages[messages.length - 1].id) ?? null : null;

    return {
      text: lines.join("\n"),
      shortIdMap,
      firstId,
      lastId,
    };
  },
};

export function createTranscript(
  messages: ContextMessage[],
  options?: TranscriptRenderOptions & { renderer?: TranscriptRenderer }
): TranscriptRenderResult {
  const renderer = options?.renderer ?? defaultTranscriptRenderer;
  return renderer.render(messages, options);
}
