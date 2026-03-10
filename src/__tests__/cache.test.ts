import { describe, test, expect } from "bun:test";
import { createCompressionCache, hashMessages } from "../cache.js";
import type { CompressionResult } from "../types.js";

function makeResult(tier: string): CompressionResult {
  return {
    messages: [],
    tier: tier as any,
    modifications: [],
    originalTokenEstimate: 100,
    compressedTokenEstimate: 50,
  };
}

describe("createCompressionCache", () => {
  test("stores and retrieves values", () => {
    const cache = createCompressionCache(10);
    const result = makeResult("rule-based");
    cache.set("key1", result);
    expect(cache.get("key1")).toEqual(result);
    expect(cache.size).toBe(1);
  });

  test("returns undefined for missing keys", () => {
    const cache = createCompressionCache(10);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  test("evicts LRU entry when maxEntries exceeded", async () => {
    const cache = createCompressionCache(2);

    cache.set("a", makeResult("a"));
    await new Promise((r) => setTimeout(r, 5));
    cache.set("b", makeResult("b"));
    await new Promise((r) => setTimeout(r, 5));

    // Access "a" to make it recently used
    cache.get("a");
    await new Promise((r) => setTimeout(r, 5));

    // Add "c" — should evict "b" (least recently accessed)
    cache.set("c", makeResult("c"));

    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });

  test("clear removes all entries", () => {
    const cache = createCompressionCache(10);
    cache.set("a", makeResult("a"));
    cache.set("b", makeResult("b"));
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("hashMessages", () => {
  test("produces consistent hashes", () => {
    const msgs = [{ role: "user", content: "hello" }];
    expect(hashMessages(msgs)).toBe(hashMessages(msgs));
  });

  test("produces different hashes for different inputs", () => {
    const a = hashMessages([{ role: "user", content: "hello" }]);
    const b = hashMessages([{ role: "user", content: "world" }]);
    expect(a).not.toBe(b);
  });
});
