import { describe, it, expect, beforeEach } from "vitest";
import { LlmCache, getLlmCache, resetLlmCache } from "../src/core/llm-cache.js";

describe("LlmCache", () => {
  let cache: LlmCache;

  beforeEach(() => {
    cache = new LlmCache({ maxEntries: 10, ttlMs: 60_000 });
  });

  describe("buildKey", () => {
    it("same inputs produce same key", () => {
      const k1 = cache.buildKey("hello", "gpt-4", 0.7);
      const k2 = cache.buildKey("hello", "gpt-4", 0.7);
      expect(k1).toBe(k2);
    });

    it("different prompts produce different keys", () => {
      const k1 = cache.buildKey("hello", "gpt-4", 0.7);
      const k2 = cache.buildKey("world", "gpt-4", 0.7);
      expect(k1).not.toBe(k2);
    });

    it("different models produce different keys", () => {
      const k1 = cache.buildKey("hello", "gpt-4", 0.7);
      const k2 = cache.buildKey("hello", "gpt-3.5", 0.7);
      expect(k1).not.toBe(k2);
    });

    it("different temperatures produce different keys", () => {
      const k1 = cache.buildKey("hello", "gpt-4", 0.7);
      const k2 = cache.buildKey("hello", "gpt-4", 0.9);
      expect(k1).not.toBe(k2);
    });

    it("float stability: 0.7 and 0.70000000001 round to same key", () => {
      const k1 = cache.buildKey("hello", "gpt-4", 0.7);
      const k2 = cache.buildKey("hello", "gpt-4", 0.70000000001);
      expect(k1).toBe(k2);
    });
  });

  describe("get/set round-trip", () => {
    it("returns cached response on hit", () => {
      const key = cache.buildKey("prompt", "model", 0.5);
      cache.set(key, "response text", 100, "model");
      expect(cache.get(key)).toBe("response text");
    });

    it("returns null on miss", () => {
      expect(cache.get("nonexistent")).toBeNull();
    });
  });

  describe("TTL expiry", () => {
    it("expires entries after ttlMs", async () => {
      const shortCache = new LlmCache({ maxEntries: 10, ttlMs: 10 });
      const key = shortCache.buildKey("p", "m", 0);
      shortCache.set(key, "val", 1, "m");
      expect(shortCache.get(key)).toBe("val");
      await new Promise((r) => setTimeout(r, 20));
      expect(shortCache.get(key)).toBeNull();
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when maxEntries exceeded", () => {
      const small = new LlmCache({ maxEntries: 2, ttlMs: 60_000 });
      const k1 = small.buildKey("a", "m", 0);
      const k2 = small.buildKey("b", "m", 0);
      const k3 = small.buildKey("c", "m", 0);

      small.set(k1, "r1", 1, "m");
      small.set(k2, "r2", 1, "m");
      small.set(k3, "r3", 1, "m");

      // k1 should be evicted
      expect(small.get(k1)).toBeNull();
      expect(small.get(k2)).toBe("r2");
      expect(small.get(k3)).toBe("r3");
    });

    it("LRU access refreshes position", () => {
      const small = new LlmCache({ maxEntries: 2, ttlMs: 60_000 });
      const k1 = small.buildKey("a", "m", 0);
      const k2 = small.buildKey("b", "m", 0);
      const k3 = small.buildKey("c", "m", 0);

      small.set(k1, "r1", 1, "m");
      small.set(k2, "r2", 1, "m");

      // Access k1 to refresh it
      small.get(k1);

      // Now insert k3 — k2 should be evicted (oldest)
      small.set(k3, "r3", 1, "m");

      expect(small.get(k1)).toBe("r1");
      expect(small.get(k2)).toBeNull();
      expect(small.get(k3)).toBe("r3");
    });
  });

  describe("stats tracking", () => {
    it("tracks hits and misses", () => {
      const key = cache.buildKey("p", "m", 0);
      cache.set(key, "val", 10, "m");

      cache.get(key); // hit
      cache.get(key); // hit
      cache.get("miss"); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });

    it("tracks evictions", () => {
      const small = new LlmCache({ maxEntries: 1, ttlMs: 60_000 });
      small.set(small.buildKey("a", "m", 0), "r1", 1, "m");
      small.set(small.buildKey("b", "m", 0), "r2", 1, "m");

      expect(small.getStats().evictions).toBe(1);
    });

    it("tracks estimatedSavedChars on hits", () => {
      const key = cache.buildKey("p", "m", 0);
      cache.set(key, "val", 500, "m");
      cache.get(key); // hit: +500
      cache.get(key); // hit: +500

      expect(cache.getStats().estimatedSavedChars).toBe(1000);
    });

    it("tracks size", () => {
      cache.set(cache.buildKey("a", "m", 0), "r1", 1, "m");
      cache.set(cache.buildKey("b", "m", 0), "r2", 1, "m");
      expect(cache.getStats().size).toBe(2);
    });
  });

  describe("clear", () => {
    it("resets everything", () => {
      const key = cache.buildKey("p", "m", 0);
      cache.set(key, "val", 10, "m");
      cache.get(key);
      cache.clear();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
      expect(stats.size).toBe(0);
      expect(stats.estimatedSavedChars).toBe(0);
      expect(cache.get(key)).toBeNull();
    });
  });

  describe("singleton", () => {
    beforeEach(() => {
      resetLlmCache();
    });

    it("getLlmCache returns same instance", () => {
      const a = getLlmCache();
      const b = getLlmCache();
      expect(a).toBe(b);
    });

    it("resetLlmCache creates fresh instance", () => {
      const a = getLlmCache();
      a.set(a.buildKey("p", "m", 0), "val", 1, "m");
      resetLlmCache();
      const b = getLlmCache();
      expect(a).not.toBe(b);
      expect(b.getStats().size).toBe(0);
    });
  });
});
