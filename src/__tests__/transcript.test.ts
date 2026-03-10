import { describe, test, expect } from "bun:test";
import { createTranscript } from "../transcript.js";
import { normalizeMessages } from "../messages.js";

describe("createTranscript", () => {
  test("renders a transcript with short ids and escaped content", () => {
    const messages = normalizeMessages([
      { role: "user", content: "Hello <world>", attributes: { source: "chat" } },
      { role: "assistant", content: "Done", toolCallId: "call-1", toolName: "search", entryType: "tool-call" },
    ]);

    const transcript = createTranscript(messages);

    expect(transcript.text).toContain("<conversation>");
    expect(transcript.text).toContain("Hello &lt;world&gt;");
    expect(transcript.text).toContain('source="chat"');
    expect(transcript.shortIdMap.size).toBe(2);
    expect(transcript.firstId).not.toBeNull();
    expect(transcript.lastId).not.toBeNull();
  });
});
