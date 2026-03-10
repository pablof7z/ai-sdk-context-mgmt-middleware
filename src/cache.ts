import type { CompressionCache } from "./types.js";

interface CacheEntry<T> {
  value: T;
  lastAccessed: number;
}

export function createCompressionCache<T>(
  options: number | { maxEntries?: number } = 50
): CompressionCache<T> {
  const maxEntries = typeof options === "number" ? options : (options.maxEntries ?? 50);
  const store = new Map<string, CacheEntry<T>>();

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

    if (oldestKey) {
      store.delete(oldestKey);
    }
  }

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      entry.lastAccessed = Date.now();
      return entry.value;
    },

    set(key: string, value: T): void {
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

export function hashValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 5381;

  for (let i = 0; i < serialized.length; i++) {
    hash = ((hash << 5) + hash + serialized.charCodeAt(i)) | 0;
  }

  return (hash >>> 0).toString(36);
}

export function hashMessages(messages: unknown[]): string {
  return hashValue(messages);
}
