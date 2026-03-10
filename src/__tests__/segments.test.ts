import { describe, test, expect } from "bun:test";
import { applySegments, validateSegments } from "../segments.js";
import { normalizeMessages } from "../messages.js";

describe("validateSegments", () => {
  test("accepts disjoint persisted segments by default", () => {
    const messages = normalizeMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);

    const result = validateSegments(messages, [
      { fromId: messages[0].id, toId: messages[1].id, compressed: "ab" },
      { fromId: messages[3].id, toId: messages[3].id, compressed: "d" },
    ]);

    expect(result).toEqual({ valid: true });
  });

  test("rejects gaps when full coverage is required", () => {
    const messages = normalizeMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);

    const result = validateSegments(
      messages,
      [
        { fromId: messages[0].id, toId: messages[0].id, compressed: "a" },
        { fromId: messages[2].id, toId: messages[2].id, compressed: "c" },
      ],
      { requireFullCoverage: true }
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain("gap");
  });

  test("rejects overlaps", () => {
    const messages = normalizeMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);

    const result = validateSegments(messages, [
      { fromId: messages[0].id, toId: messages[1].id, compressed: "ab" },
      { fromId: messages[1].id, toId: messages[2].id, compressed: "bc" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("overlaps");
  });
});

describe("applySegments", () => {
  test("replaces covered ranges with summary messages", () => {
    const messages = normalizeMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);

    const result = applySegments(messages, [
      { fromId: messages[0].id, toId: messages[1].id, compressed: "ab" },
      { fromId: messages[2].id, toId: messages[2].id, compressed: "c" },
    ]);

    expect(result.map((message) => message.entryType)).toEqual(["summary", "summary", "text"]);
    expect(result[0].content).toContain("ab");
    expect(result[1].content).toContain("c");
    expect(result[2].content).toBe("d");
  });
});
