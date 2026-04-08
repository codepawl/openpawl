import { describe, it, expect } from "bun:test";
import { ResponseCache } from "../../src/cache/response-cache.js";

describe("ResponseCache", () => {
  it("exact match: same key → hit", async () => {
    const cache = new ResponseCache();
    const key = { prompt: "hello", systemPromptHash: "abc", modelName: "gpt-4o", agentId: "coder" };
    await cache.set(key, { content: "world", tokenCount: 10, cachedAt: Date.now() });
    expect(await cache.get(key)).not.toBeNull();
    expect((await cache.get(key))!.content).toBe("world");
  });

  it("different model → miss", async () => {
    const cache = new ResponseCache();
    await cache.set({ prompt: "hello", systemPromptHash: "abc", modelName: "gpt-4o", agentId: "coder" },
      { content: "world", tokenCount: 10, cachedAt: Date.now() });
    const result = await cache.get({ prompt: "hello", systemPromptHash: "abc", modelName: "claude-sonnet", agentId: "coder" });
    expect(result).toBeNull();
  });

  it("TTL expired → miss", async () => {
    const cache = new ResponseCache();
    const key = { prompt: "hello", systemPromptHash: "abc", modelName: "gpt-4o", agentId: "coder" };
    await cache.set(key, { content: "world", tokenCount: 10, cachedAt: Date.now() }, 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get(key)).toBeNull();
  });

  it("clear empties cache", async () => {
    const cache = new ResponseCache();
    await cache.set({ prompt: "a", systemPromptHash: "b", modelName: "c", agentId: "d" },
      { content: "x", tokenCount: 1, cachedAt: Date.now() });
    cache.clear();
    expect(cache.getStats().entries).toBe(0);
  });
});
