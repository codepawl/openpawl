import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamChunk, StreamOptions } from "../src/client/types.js";
import type { StreamProvider } from "../src/providers/provider.js";
import { ProviderError } from "../src/providers/types.js";

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

function makeProvider(name: string, overrides: Partial<StreamProvider> = {}): StreamProvider {
  return {
    name,
    stream: overrides.stream ?? (async function* () {
      yield { content: `from-${name}`, done: false };
      yield { content: "", done: true };
    }),
    healthCheck: overrides.healthCheck ?? (async () => true),
    isAvailable: overrides.isAvailable ?? (() => true),
    setAvailable: overrides.setAvailable ?? (() => {}),
  };
}

function failingProvider(name: string, error: ProviderError): StreamProvider {
  return makeProvider(name, {
    stream: async function* () { throw error; },
  });
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of gen) result.push(chunk);
  return result;
}

// Lazy import to avoid hoisting issues with mocks
async function createManager(providers: StreamProvider[]) {
  const { ProviderManager } = await import("../src/providers/provider-manager.js");
  return new ProviderManager(providers);
}

describe("ProviderManager", () => {
  it("tries first provider on success", async () => {
    const mgr = await createManager([makeProvider("openclaw"), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-openclaw");
    expect(mgr.getStats().openclaw.requests).toBe(1);
  });

  it("switches to next provider on ECONNREFUSED", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "CONNECTION_FAILED",
      message: "ECONNREFUSED", isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
    expect(mgr.getStats().fallbacksTriggered).toBe(1);
  });

  it("switches on first-chunk timeout", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "FIRST_CHUNK_TIMEOUT",
      message: "Timeout", isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
  });

  it("does NOT switch on 4xx (except 429)", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "STREAM_FAILED",
      message: "HTTP 401", statusCode: 401, isFallbackTrigger: false,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    await expect(collectChunks(mgr.stream("test"))).rejects.toThrow("HTTP 401");
    expect(mgr.getStats().anthropic.requests).toBe(0);
  });

  it("switches on 429", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "STREAM_FAILED",
      message: "HTTP 429", statusCode: 429, isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
  });

  it("throws ProviderError when all providers fail", async () => {
    const err1 = new ProviderError({
      provider: "openclaw", code: "CONNECTION_FAILED",
      message: "down", isFallbackTrigger: true,
    });
    const err2 = new ProviderError({
      provider: "anthropic", code: "STREAM_FAILED",
      message: "also down", isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err1), failingProvider("anthropic", err2)]);
    await expect(collectChunks(mgr.stream("test"))).rejects.toThrow("ALL_PROVIDERS_FAILED");
  });

  it("skips unavailable providers immediately", async () => {
    const unavailable = makeProvider("openclaw", { isAvailable: () => false });
    const mgr = await createManager([unavailable, makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
    expect(mgr.getStats().openclaw.requests).toBe(0);
  });

  it("stats track requests, failures, and fallbacks", async () => {
    const err = new ProviderError({
      provider: "openclaw", code: "CONNECTION_FAILED",
      message: "down", isFallbackTrigger: true,
    });
    const mgr = await createManager([failingProvider("openclaw", err), makeProvider("anthropic")]);
    await collectChunks(mgr.stream("test1"));
    await collectChunks(mgr.stream("test2"));

    const stats = mgr.getStats();
    expect(stats.openclaw.requests).toBe(2);
    expect(stats.openclaw.failures).toBe(2);
    expect(stats.anthropic.requests).toBe(2);
    expect(stats.anthropic.failures).toBe(0);
    expect(stats.fallbacksTriggered).toBe(2);
  });
});
