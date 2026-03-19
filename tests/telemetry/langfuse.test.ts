import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

// Mock langfuse module
vi.mock("langfuse", () => ({
  Langfuse: vi.fn().mockImplementation(() => ({
    trace: vi.fn().mockReturnValue({
      span: vi.fn().mockReturnValue({}),
      update: vi.fn(),
    }),
    generation: vi.fn().mockReturnValue({
      end: vi.fn(),
    }),
    flushAsync: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { getLangfuse, flushLangfuse, resetLangfuse } from "../../src/telemetry/langfuse.js";
import { createTracedProvider } from "../../src/telemetry/traced-provider.js";
import { SprintTrace } from "../../src/telemetry/sprint-trace.js";
import type { StreamProvider } from "../../src/providers/provider.js";
import type { StreamChunk } from "../../src/providers/stream-types.js";

function makeProvider(name: string): StreamProvider {
  return {
    name,
    async *stream() {
      yield { content: "hello", done: false } as StreamChunk;
      yield { content: "", done: true, usage: { promptTokens: 10, completionTokens: 5 } } as StreamChunk;
    },
    healthCheck: async () => true,
    isAvailable: () => true,
    setAvailable: () => {},
  };
}

describe("Langfuse integration", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetLangfuse();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("getLangfuse() returns null when keys not set", () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    expect(getLangfuse()).toBeNull();
  });

  it("getLangfuse() returns instance when keys set", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    const lf = getLangfuse();
    expect(lf).not.toBeNull();
  });

  it("getLangfuse() returns same instance on second call", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    const a = getLangfuse();
    const b = getLangfuse();
    expect(a).toBe(b);
  });

  it("createTracedProvider returns original provider when no Langfuse", () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const p = makeProvider("test");
    const traced = createTracedProvider(p, "session-1");
    expect(traced).toBe(p);
  });

  it("createTracedProvider wraps stream when Langfuse configured", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    const p = makeProvider("test");
    const traced = createTracedProvider(p, "session-1");
    expect(traced).not.toBe(p);

    const chunks: StreamChunk[] = [];
    for await (const chunk of traced.stream("hello")) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.content).toBe("hello");
  });

  it("SprintTrace is no-op when Langfuse not configured", () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const trace = new SprintTrace("sprint-1", "test goal");
    // Should not throw
    expect(trace.agentSpan("coder", "task-1")).toBeNull();
    trace.end({ success: true, tasksCompleted: 1, durationMs: 1000 });
  });

  it("SprintTrace creates trace when Langfuse configured", () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    const trace = new SprintTrace("sprint-1", "test goal", "user-1");
    // Should not throw
    trace.end({ success: true, tasksCompleted: 3, durationMs: 5000 });
  });

  it("flushLangfuse() resolves when no instance", async () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    await expect(flushLangfuse()).resolves.toBeUndefined();
  });
});
