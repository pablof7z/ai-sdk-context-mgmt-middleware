import { describe, test, expect } from "bun:test";
import { createCompressionCache, hashMessages, hashValue } from "../cache.js";

describe("createCompressionCache", () => {
  test("stores and retrieves values", () => {
    const cache = createCompressionCache<string>(10);
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
    expect(cache.size).toBe(1);
  });

  test("returns undefined for missing keys", () => {
    const cache = createCompressionCache<string>(10);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("evicts the least recently used entry", async () => {
    const cache = createCompressionCache<string>(2);

    cache.set("a", "one");
    await new Promise((resolve) => setTimeout(resolve, 5));
    cache.set("b", "two");
    await new Promise((resolve) => setTimeout(resolve, 5));
    cache.get("a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    cache.set("c", "three");

    expect(cache.get("a")).toBe("one");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("three");
  });

  test("clear removes all entries", () => {
    const cache = createCompressionCache<string>(10);
    cache.set("a", "one");
    cache.set("b", "two");
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("hash helpers", () => {
  test("hashValue is stable for the same value", () => {
    expect(hashValue({ role: "user", content: "hello" })).toBe(
      hashValue({ role: "user", content: "hello" })
    );
  });

  test("hashMessages distinguishes different values", () => {
    expect(hashMessages([{ role: "user", content: "hello" }])).not.toBe(
      hashMessages([{ role: "user", content: "world" }])
    );
  });
});
