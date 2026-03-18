import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { StreamChunk } from "../src/client/types.js";
import { NEVER_CACHE_ROLES } from "../src/cache/types.js";

// Mock the logger to suppress output during tests
vi.mock("../src/core/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    plain: vi.fn(),
    success: vi.fn(),
  },
}));

// Helper to create an async generator from chunks
async function* makeStream(chunks: StreamChunk[]): AsyncGenerator<StreamChunk, void, undefined> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// Collect all chunks from an async generator
async function collectChunks(gen: AsyncGenerator<StreamChunk, void, undefined>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of gen) {
    result.push(chunk);
  }
  return result;
}

describe("cache interceptor", () => {
  const originalEnv = process.env.TEAMCLAW_NO_CACHE;

  beforeEach(() => {
    delete process.env.TEAMCLAW_NO_CACHE;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TEAMCLAW_NO_CACHE = originalEnv;
    } else {
      delete process.env.TEAMCLAW_NO_CACHE;
    }
  });

  it("TEAMCLAW_NO_CACHE=true bypasses all cache logic", async () => {
    process.env.TEAMCLAW_NO_CACHE = "true";

    // Re-import to get fresh module state
    const { streamWithCache, resetSessionCacheStats, getSessionCacheStats } = await import("../src/cache/cache-interceptor.js");
    resetSessionCacheStats();

    const stream = makeStream([
      { content: "hello", done: false },
      { content: "", done: true },
    ]);

    const chunks = await collectChunks(streamWithCache("test prompt", "gpt-4", "coordinator", stream));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.content).toBe("hello");

    const stats = getSessionCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  it("never-cache roles bypass cache entirely", async () => {
    const { streamWithCache, resetSessionCacheStats, getSessionCacheStats } = await import("../src/cache/cache-interceptor.js");
    resetSessionCacheStats();

    for (const role of NEVER_CACHE_ROLES) {
      const stream = makeStream([
        { content: "response", done: false },
        { content: "", done: true },
      ]);

      const chunks = await collectChunks(streamWithCache("prompt", "gpt-4", role, stream));
      expect(chunks).toHaveLength(2);
    }

    const stats = getSessionCacheStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(NEVER_CACHE_ROLES.size);
  });

  it("session-specific content (UUIDs) bypasses cache", async () => {
    const { streamWithCache, resetSessionCacheStats, getSessionCacheStats } = await import("../src/cache/cache-interceptor.js");
    resetSessionCacheStats();

    const prompt = "Process task for session 550e8400-e29b-41d4-a716-446655440000";
    const stream = makeStream([
      { content: "result", done: false },
      { content: "", done: true },
    ]);

    const chunks = await collectChunks(streamWithCache(prompt, "gpt-4", "coordinator", stream));
    expect(chunks).toHaveLength(2);

    const stats = getSessionCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
  });

  it("passes through all chunks from original stream on cache miss", async () => {
    const { streamWithCache, resetSessionCacheStats } = await import("../src/cache/cache-interceptor.js");
    resetSessionCacheStats();

    const originalChunks: StreamChunk[] = [
      { content: "chunk1", done: false },
      { content: "chunk2", done: false },
      { content: "chunk3", done: false },
      { content: "", done: true, usage: { promptTokens: 50, completionTokens: 50 } },
    ];

    const stream = makeStream(originalChunks);
    // Use a unique prompt to ensure cache miss
    const uniquePrompt = `unique prompt ${Date.now()} ${Math.random()}`;
    const chunks = await collectChunks(streamWithCache(uniquePrompt, "gpt-4", "sprint-planner", stream));

    expect(chunks).toHaveLength(4);
    expect(chunks[0]!.content).toBe("chunk1");
    expect(chunks[1]!.content).toBe("chunk2");
    expect(chunks[2]!.content).toBe("chunk3");
    expect(chunks[3]!.done).toBe(true);
  });

  it("session stats track hits and misses separately", async () => {
    const { resetSessionCacheStats, getSessionCacheStats } = await import("../src/cache/cache-interceptor.js");
    resetSessionCacheStats();

    const stats = getSessionCacheStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.savedMs).toBe(0);
    expect(stats.savedUSD).toBe(0);
  });
});
