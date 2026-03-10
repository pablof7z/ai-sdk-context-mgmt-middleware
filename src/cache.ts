import type { CompressionCache, CompressionResult } from "./types.js";

interface CacheEntry {
  value: CompressionResult;
  lastAccessed: number;
}

/**
 * Create an LRU compression cache.
 * @param maxEntries Maximum number of cached results (default: 50)
 */
export function createCompressionCache(
  options: number | { maxEntries?: number } = 50
): CompressionCache {
  const maxEntries =
    typeof options === "number" ? options : (options.maxEntries ?? 50);
  const store = new Map<string, CacheEntry>();

  function evictLRU(): void {
    if (store.size <= maxEntries) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of store) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) store.delete(oldestKey);
  }

  return {
    get(key: string): CompressionResult | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      entry.lastAccessed = Date.now();
      return entry.value;
    },

    set(key: string, value: CompressionResult): void {
      store.set(key, { value, lastAccessed: Date.now() });
      evictLRU();
    },

    clear(): void {
      store.clear();
    },

    get size(): number {
      return store.size;
    },
  };
}

/**
 * djb2 hash function for generating cache keys from message arrays.
 */
export function hashMessages(messages: unknown[]): string {
  const str = JSON.stringify(messages);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
