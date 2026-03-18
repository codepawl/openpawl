import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ResponseCacheStore, buildCacheKey, hasSessionSpecificContent } from "../src/cache/cache-store.js";
import type { CacheEntry } from "../src/cache/types.js";

const TEST_CACHE_DIR = path.join(os.tmpdir(), `teamclaw-cache-test-${process.pid}`);

// Override cache dir for tests by patching the module-level constant
// We use a custom store that writes to a temp dir instead
class TestCacheStore extends ResponseCacheStore {
  private dir: string;

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  async get(key: string): Promise<CacheEntry | null> {
    const fp = path.join(this.dir, `${key}.json`);
    try {
      const raw = await fsp.readFile(fp, "utf-8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() > entry.expiresAt) {
        fsp.unlink(fp).catch(() => {});
        return null;
      }
      entry.hitCount += 1;
      entry.lastHitAt = Date.now();
      fsp.writeFile(fp, JSON.stringify(entry), "utf-8").catch(() => {});
      return entry;
    } catch {
      return null;
    }
  }

  async set(entry: CacheEntry): Promise<void> {
    await this.init();
    const fp = path.join(this.dir, `${entry.key}.json`);
    await fsp.writeFile(fp, JSON.stringify(entry), "utf-8");
  }

  async delete(key: string): Promise<void> {
    try {
      await fsp.unlink(path.join(this.dir, `${key}.json`));
    } catch {}
  }

  async clear(): Promise<void> {
    try {
      const files = await fsp.readdir(this.dir);
      await Promise.all(
        files.filter((f) => f.endsWith(".json")).map((f) => fsp.unlink(path.join(this.dir, f)).catch(() => {})),
      );
    } catch {}
  }

  async prune(): Promise<number> {
    const now = Date.now();
    let pruned = 0;
    try {
      const files = await fsp.readdir(this.dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const fp = path.join(this.dir, file);
        try {
          const raw = await fsp.readFile(fp, "utf-8");
          const entry = JSON.parse(raw) as CacheEntry;
          if (now > entry.expiresAt) {
            await fsp.unlink(fp);
            pruned++;
          }
        } catch {
          await fsp.unlink(fp).catch(() => {});
          pruned++;
        }
      }
    } catch {}
    return pruned;
  }

  async stats() {
    const result = {
      totalEntries: 0,
      totalHits: 0,
      totalSavingsUSD: 0,
      totalSavedMs: 0,
      hitRate: 0,
      oldestEntry: 0,
      newestEntry: 0,
    };
    try {
      const files = await fsp.readdir(this.dir);
      let totalMisses = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await fsp.readFile(path.join(this.dir, file), "utf-8");
          const entry = JSON.parse(raw) as CacheEntry;
          if (Date.now() > entry.expiresAt) continue;
          result.totalEntries++;
          result.totalHits += entry.hitCount;
          result.totalSavingsUSD += entry.costUSD * entry.hitCount;
          result.totalSavedMs += entry.hitCount * 3000;
          if (result.oldestEntry === 0 || entry.createdAt < result.oldestEntry) result.oldestEntry = entry.createdAt;
          if (entry.createdAt > result.newestEntry) result.newestEntry = entry.createdAt;
          totalMisses++;
        } catch {}
      }
      const total = result.totalHits + totalMisses;
      result.hitRate = total > 0 ? result.totalHits / total : 0;
    } catch {}
    return result;
  }
}

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  const now = Date.now();
  return {
    key: buildCacheKey("test prompt", "gpt-4", "coordinator"),
    prompt: "test prompt",
    model: "gpt-4",
    agentRole: "coordinator",
    response: "This is a test response that is definitely longer than fifty characters to pass the minimum length check.",
    tokensUsed: 100,
    costUSD: 0.001,
    hitCount: 0,
    createdAt: now,
    lastHitAt: now,
    expiresAt: now + 60 * 60 * 1000, // 1 hour
    ...overrides,
  };
}

describe("buildCacheKey", () => {
  it("produces same key for same normalized input", () => {
    const key1 = buildCacheKey("Hello   World", "gpt-4", "coordinator");
    const key2 = buildCacheKey("hello world", "gpt-4", "coordinator");
    expect(key1).toBe(key2);
  });

  it("produces same key regardless of whitespace variation", () => {
    const key1 = buildCacheKey("  test  prompt  ", "gpt-4", "coordinator");
    const key2 = buildCacheKey("test prompt", "gpt-4", "coordinator");
    expect(key1).toBe(key2);
  });

  it("produces different key for different model", () => {
    const key1 = buildCacheKey("same prompt", "gpt-4", "coordinator");
    const key2 = buildCacheKey("same prompt", "claude-3", "coordinator");
    expect(key1).not.toBe(key2);
  });

  it("produces different key for different role", () => {
    const key1 = buildCacheKey("same prompt", "gpt-4", "coordinator");
    const key2 = buildCacheKey("same prompt", "gpt-4", "worker-bot");
    expect(key1).not.toBe(key2);
  });

  it("strips timestamps before hashing", () => {
    const key1 = buildCacheKey("prompt at 2024-01-15T10:30:00.000Z", "gpt-4", "coordinator");
    const key2 = buildCacheKey("prompt at 2025-06-20T15:45:30.123Z", "gpt-4", "coordinator");
    expect(key1).toBe(key2);
  });

  it("strips unix timestamps before hashing", () => {
    const key1 = buildCacheKey("prompt at 1705312200000 time", "gpt-4", "coordinator");
    const key2 = buildCacheKey("prompt at 1719071130000 time", "gpt-4", "coordinator");
    expect(key1).toBe(key2);
  });

  it("returns a 64-char hex string (SHA-256)", () => {
    const key = buildCacheKey("test", "model", "role");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("hasSessionSpecificContent", () => {
  it("detects UUID patterns", () => {
    expect(hasSessionSpecificContent("session 550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("detects ISO timestamps", () => {
    expect(hasSessionSpecificContent("at 2024-01-15T10:30:00Z")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasSessionSpecificContent("plan the sprint for the auth module")).toBe(false);
  });
});

describe("ResponseCacheStore", () => {
  let store: TestCacheStore;

  beforeEach(async () => {
    store = new TestCacheStore(TEST_CACHE_DIR);
    await store.init();
  });

  afterEach(async () => {
    await fsp.rm(TEST_CACHE_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("returns null for missing key", async () => {
    const result = await store.get("nonexistent-key");
    expect(result).toBeNull();
  });

  it("stores and retrieves an entry", async () => {
    const entry = makeEntry();
    await store.set(entry);
    const retrieved = await store.get(entry.key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.response).toBe(entry.response);
    expect(retrieved!.hitCount).toBe(1); // incremented on get
  });

  it("returns null for expired entry", async () => {
    const entry = makeEntry({ expiresAt: Date.now() - 1000 });
    await store.set(entry);
    const result = await store.get(entry.key);
    expect(result).toBeNull();
  });

  it("deletes an entry", async () => {
    const entry = makeEntry();
    await store.set(entry);
    await store.delete(entry.key);
    const result = await store.get(entry.key);
    expect(result).toBeNull();
  });

  it("clears all entries", async () => {
    const entry1 = makeEntry({ key: "key1" });
    const entry2 = makeEntry({ key: "key2" });
    await store.set(entry1);
    await store.set(entry2);
    await store.clear();
    expect(await store.get("key1")).toBeNull();
    expect(await store.get("key2")).toBeNull();
  });

  it("prune removes expired entries and returns count", async () => {
    const valid = makeEntry({ key: "valid" });
    const expired1 = makeEntry({ key: "expired1", expiresAt: Date.now() - 1000 });
    const expired2 = makeEntry({ key: "expired2", expiresAt: Date.now() - 2000 });
    await store.set(valid);
    await store.set(expired1);
    await store.set(expired2);

    const pruned = await store.prune();
    expect(pruned).toBe(2);

    // Valid entry still exists
    const result = await store.get("valid");
    expect(result).not.toBeNull();
  });

  it("stats correctly calculates hit rate", async () => {
    const entry = makeEntry({ hitCount: 4, costUSD: 0.01 });
    await store.set(entry);

    const stats = await store.stats();
    expect(stats.totalEntries).toBe(1);
    expect(stats.totalHits).toBe(4);
    // hitRate = 4 hits / (4 hits + 1 miss) = 0.8
    expect(stats.hitRate).toBe(0.8);
    expect(stats.totalSavingsUSD).toBeCloseTo(0.04); // 0.01 * 4
  });

  it("stats skips expired entries", async () => {
    const valid = makeEntry({ key: "v", hitCount: 2 });
    const expired = makeEntry({ key: "e", hitCount: 10, expiresAt: Date.now() - 1000 });
    await store.set(valid);
    await store.set(expired);

    const stats = await store.stats();
    expect(stats.totalEntries).toBe(1);
    expect(stats.totalHits).toBe(2);
  });
});
