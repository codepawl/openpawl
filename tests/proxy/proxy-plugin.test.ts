import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { StreamChunk } from "@/providers/stream-types.js";
import type { StreamProvider } from "@/providers/provider.js";
import { ProviderError } from "@/providers/types.js";

// ---------------------------------------------------------------------------
// Mock the global provider manager
// ---------------------------------------------------------------------------

const mockStream = vi.fn();

const mockProvider: StreamProvider = {
  name: "test",
  stream: mockStream,
  healthCheck: vi.fn().mockResolvedValue(true),
  isAvailable: vi.fn().mockReturnValue(true),
  setAvailable: vi.fn(),
};

// We need to mock at the ProxyService level since the factory imports are ESM
vi.mock("@/proxy/ProxyService.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/proxy/ProxyService.js")>();
  const { ProviderManager } = await import("@/providers/provider-manager.js");
  const { HealthMonitor } = await import("@/providers/health-monitor.js");
  return {
    ...mod,
    createProxyService: () => {
      const mgr = new ProviderManager([mockProvider]);
      const monitor = new HealthMonitor([mockProvider]);
      return new mod.ProxyService(mgr, monitor);
    },
  };
});

vi.mock("@/core/mock-llm.js", () => ({
  isMockLlmEnabled: () => false,
  generateMockResponse: () => "mock",
}));

vi.mock("@/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* makeChunks(
  chunks: StreamChunk[],
): AsyncGenerator<StreamChunk, void, undefined> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function parseSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .filter((block) => block.trim().startsWith("data:"))
    .map((block) => {
      const dataLine = block.trim().replace(/^data:\s*/, "");
      return JSON.parse(dataLine) as Record<string, unknown>;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxyPlugin", () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    (mockProvider.isAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);

    fastify = Fastify();
    const { proxyPlugin } = await import("@/proxy/plugin.js");
    await fastify.register(proxyPlugin, { basePath: "/proxy" });
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe("GET /proxy/health", () => {
    it("returns health status", async () => {
      const res = await fastify.inject({ method: "GET", url: "/proxy/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("connected", true);
      expect(body).toHaveProperty("uptime");
      expect(typeof body.uptime).toBe("number");
    });
  });

  describe("GET /proxy/stream", () => {
    it("yields SSE chunk and done events", async () => {
      mockStream.mockImplementation(() =>
        makeChunks([
          { content: "Hello", done: false },
          { content: " world", done: false },
          { content: "", done: true },
        ]),
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/proxy/stream?prompt=hello",
      });

      expect(res.headers["content-type"]).toBe("text/event-stream");
      const events = parseSseEvents(res.body);
      const chunks = events.filter((e) => e.event === "chunk");
      const done = events.find((e) => e.event === "done");

      expect(chunks).toHaveLength(3);
      expect((chunks[0].data as Record<string, unknown>).content).toBe("Hello");
      expect((chunks[0].data as Record<string, unknown>).index).toBe(0);
      expect((chunks[1].data as Record<string, unknown>).content).toBe(" world");
      expect((chunks[1].data as Record<string, unknown>).index).toBe(1);
      expect(done).toBeDefined();
      expect((done!.data as Record<string, unknown>).totalChunks).toBe(3);
    });

    it("maps stream errors to SSE error events", async () => {
      mockStream.mockImplementation(async function* () {
        throw new ProviderError({
          provider: "test",
          code: "STREAM_FAILED",
          message: "upstream error",
          isFallbackTrigger: false,
        });
      });

      const res = await fastify.inject({
        method: "GET",
        url: "/proxy/stream?prompt=hello",
      });

      const events = parseSseEvents(res.body);
      const errorEvt = events.find((e) => e.event === "error");
      expect(errorEvt).toBeDefined();
      const data = errorEvt!.data as Record<string, unknown>;
      expect(data.code).toBe("STREAM_FAILED");
      expect(data.message).toContain("upstream error");
    });

    it("returns 400 when prompt is missing", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/proxy/stream",
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 on invalid JSON in options", async () => {
      const res = await fastify.inject({
        method: "GET",
        url: "/proxy/stream?prompt=test&options={bad",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("concurrent streams", () => {
    it("handles 3 parallel streams independently", async () => {
      let callCount = 0;
      mockStream.mockImplementation(() => {
        const id = ++callCount;
        return makeChunks([
          { content: `response-${id}`, done: false },
          { content: "", done: true },
        ]);
      });

      const [r1, r2, r3] = await Promise.all([
        fastify.inject({ method: "GET", url: "/proxy/stream?prompt=a" }),
        fastify.inject({ method: "GET", url: "/proxy/stream?prompt=b" }),
        fastify.inject({ method: "GET", url: "/proxy/stream?prompt=c" }),
      ]);

      for (const res of [r1, r2, r3]) {
        const events = parseSseEvents(res.body);
        const chunks = events.filter((e) => e.event === "chunk");
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        const done = events.find((e) => e.event === "done");
        expect(done).toBeDefined();
      }
    });
  });

  describe("POST /proxy/reconnect", () => {
    it("resets provider health state and returns success", async () => {
      const res = await fastify.inject({
        method: "POST",
        url: "/proxy/reconnect",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({ success: true, message: "Provider health state reset" });
    });
  });
});
