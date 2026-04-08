import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamChunk } from "@/providers/stream-types.js";

/* ------------------------------------------------------------------ */
/*  Hoisted mocks                                                     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    plain: vi.fn(),
    success: vi.fn(),
    agent: vi.fn(),
  };
  const mockIsMockLlmEnabled = vi.fn().mockReturnValue(false);
  const mockGenerateMockResponse = vi.fn().mockReturnValue("mock response text");
  const mockResolveModelForAgent = vi.fn().mockReturnValue("claude-sonnet-4-6");
  const mockSemanticCache = {
    init: vi.fn().mockResolvedValue(undefined),
    lookup: vi.fn().mockResolvedValue(null),
    store: vi.fn().mockResolvedValue(undefined),
  };
  const mockTrafficController = {
    acquire: vi.fn().mockResolvedValue(true),
    release: vi.fn(),
  };
  const mockLlmEvents = { emit: vi.fn() };
  const mockExtractFileBlocks = vi.fn().mockReturnValue([]);
  const mockWriteFileBlocks = vi.fn().mockResolvedValue([]);
  const mockMgrStream = vi.fn();
  const mockMgr = {
    stream: mockMgrStream,
    generate: vi.fn(),
    getProviders: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({ fallbacksTriggered: 0 }),
    resetStats: vi.fn(),
  };
  const mockGetGlobalProviderManager = vi.fn().mockReturnValue(mockMgr);

  return {
    mockLogger,
    mockIsMockLlmEnabled,
    mockGenerateMockResponse,
    mockResolveModelForAgent,
    mockSemanticCache,
    mockTrafficController,
    mockLlmEvents,
    mockExtractFileBlocks,
    mockWriteFileBlocks,
    mockMgrStream,
    mockMgr,
    mockGetGlobalProviderManager,
  };
});

vi.mock("@/core/config.js", () => ({
  CONFIG: { vectorStorePath: "/tmp/test-vectors", memoryBackend: "local_json", llmTimeoutMs: 30000 },
}));

vi.mock("@/core/logger.js", () => ({
  logger: mocks.mockLogger,
  isDebugMode: () => false,
}));

vi.mock("@/core/mock-llm.js", () => ({
  isMockLlmEnabled: mocks.mockIsMockLlmEnabled,
  generateMockResponse: mocks.mockGenerateMockResponse,
}));

vi.mock("@/core/model-config.js", () => ({
  resolveModelForAgent: mocks.mockResolveModelForAgent,
}));

vi.mock("@/providers/provider-factory.js", () => ({
  getGlobalProviderManager: mocks.mockGetGlobalProviderManager,
}));

vi.mock("@/token-opt/semantic-cache.js", () => ({
  getSemanticCache: () => mocks.mockSemanticCache,
}));

vi.mock("@/core/traffic-control.js", () => ({
  getTrafficController: () => mocks.mockTrafficController,
}));

vi.mock("@/core/llm-events.js", () => ({
  llmEvents: mocks.mockLlmEvents,
}));

vi.mock("@/utils/file-block-parser.js", () => ({
  extractFileBlocks: mocks.mockExtractFileBlocks,
  writeFileBlocks: mocks.mockWriteFileBlocks,
}));

import { UniversalWorkerAdapter } from "@/adapters/worker-adapter.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeMockStream(chunks: StreamChunk[]) {
  return vi.fn(async function* () {
    for (const c of chunks) yield c;
  });
}

function defaultChunks(text = "Hello world"): StreamChunk[] {
  return [
    { content: text, done: false },
    { content: "", done: true, usage: { promptTokens: 100, completionTokens: 50 } },
  ];
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("UniversalWorkerAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockIsMockLlmEnabled.mockReturnValue(false);
    mocks.mockSemanticCache.lookup.mockResolvedValue(null);
    mocks.mockMgrStream.mockImplementation(async function* () {
      yield { content: "Hello world", done: false } satisfies StreamChunk;
      yield { content: "", done: true, usage: { promptTokens: 100, completionTokens: 50 } } satisfies StreamChunk;
    });
  });

  /* ============================================================== */
  /*  complete() — request construction                             */
  /* ============================================================== */
  describe("complete() — request construction", () => {
    it("passes user message as prompt and system message as systemPrompt to provider", async () => {
      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      await adapter.complete([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Write code" },
      ]);

      expect(mocks.mockMgrStream).toHaveBeenCalledTimes(1);
      const [prompt, opts] = mocks.mockMgrStream.mock.calls[0]!;
      expect(prompt).toBe("Write code");
      expect(opts.systemPrompt).toBe("You are helpful");
    });

    it("resolves model from config when no explicit model set", async () => {
      const adapter = new UniversalWorkerAdapter({ botId: "programmer" });
      await adapter.complete([{ role: "user", content: "ping" }]);

      expect(mocks.mockResolveModelForAgent).toHaveBeenCalledWith("programmer");
      const [, opts] = mocks.mockMgrStream.mock.calls[0]!;
      expect(opts.model).toBe("claude-sonnet-4-6");
    });

    it("uses configured model when explicitly set in constructor", async () => {
      const adapter = new UniversalWorkerAdapter({ model: "gpt-4o", botId: "worker" });
      await adapter.complete([{ role: "user", content: "ping" }]);

      const [, opts] = mocks.mockMgrStream.mock.calls[0]!;
      expect(opts.model).toBe("gpt-4o");
    });

    it("creates combined AbortSignal from timeout and caller signal", async () => {
      const controller = new AbortController();
      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      await adapter.complete([{ role: "user", content: "ping" }], { signal: controller.signal });

      const [, opts] = mocks.mockMgrStream.mock.calls[0]!;
      expect(opts.signal).toBeDefined();
      // The combined signal is not the same object as the caller signal
      expect(opts.signal).not.toBe(controller.signal);
    });
  });

  /* ============================================================== */
  /*  complete() — response parsing                                 */
  /* ============================================================== */
  describe("complete() — response parsing", () => {
    it("concatenates all stream chunks into final response", async () => {
      mocks.mockMgrStream.mockImplementation(async function* () {
        yield { content: "Hello", done: false } satisfies StreamChunk;
        yield { content: " ", done: false } satisfies StreamChunk;
        yield { content: "world", done: false } satisfies StreamChunk;
        yield { content: "", done: true } satisfies StreamChunk;
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      const result = await adapter.complete([{ role: "user", content: "test" }]);
      expect(result).toBe("Hello world");
    });

    it("strips <think> tags and extracts reasoning", async () => {
      const onReasoning = vi.fn();
      mocks.mockMgrStream.mockImplementation(async function* () {
        yield { content: "<think>I should use auth</think>Implement JWT login", done: false } satisfies StreamChunk;
        yield { content: "", done: true } satisfies StreamChunk;
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker", onReasoning });
      const result = await adapter.complete([{ role: "user", content: "test" }]);

      expect(result).toBe("Implement JWT login");
      expect(onReasoning).toHaveBeenCalledWith("I should use auth");
    });

    it("tracks token usage from final stream chunk", async () => {
      const onTokenUsage = vi.fn();
      mocks.mockMgrStream.mockImplementation(async function* () {
        yield { content: "response", done: false } satisfies StreamChunk;
        yield { content: "", done: true, usage: { promptTokens: 100, completionTokens: 50 } } satisfies StreamChunk;
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker", onTokenUsage });
      await adapter.complete([{ role: "user", content: "test" }]);

      expect(onTokenUsage).toHaveBeenCalledWith(100, 50, 0, expect.any(String));
    });
  });

  /* ============================================================== */
  /*  complete() — mock LLM mode                                    */
  /* ============================================================== */
  describe("complete() — mock LLM mode", () => {
    it("returns mock response without calling provider when mock mode enabled", async () => {
      mocks.mockIsMockLlmEnabled.mockReturnValue(true);
      const onTokenUsage = vi.fn();

      const adapter = new UniversalWorkerAdapter({ botId: "worker", onTokenUsage });
      const result = await adapter.complete([{ role: "user", content: "test" }]);

      expect(result).toBe("mock response text");
      expect(mocks.mockMgrStream).not.toHaveBeenCalled();
      expect(onTokenUsage).toHaveBeenCalledWith(500, 200, 0, "mock-model");
    });
  });

  /* ============================================================== */
  /*  complete() — semantic cache                                   */
  /* ============================================================== */
  describe("complete() — semantic cache", () => {
    it("returns cached response without calling provider when cache hits", async () => {
      mocks.mockSemanticCache.lookup.mockResolvedValue("cached answer");

      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      const result = await adapter.complete([{ role: "user", content: "test" }]);

      expect(result).toBe("cached answer");
      expect(mocks.mockMgrStream).not.toHaveBeenCalled();
    });

    it("stores response in semantic cache after successful LLM call", async () => {
      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      await adapter.complete([{ role: "user", content: "test" }]);

      expect(mocks.mockSemanticCache.store).toHaveBeenCalledWith(
        "test",
        expect.any(String),
        "worker",
        "Hello world",
      );
    });

    it("falls through to LLM when cache lookup fails", async () => {
      mocks.mockSemanticCache.lookup.mockRejectedValue(new Error("cache broken"));

      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      const result = await adapter.complete([{ role: "user", content: "test" }]);

      expect(result).toBe("Hello world");
      expect(mocks.mockMgrStream).toHaveBeenCalled();
    });
  });

  /* ============================================================== */
  /*  complete() — error handling                                   */
  /* ============================================================== */
  describe("complete() — error handling", () => {
    it("throws when provider stream fails", async () => {
      const onStreamDone = vi.fn();
      mocks.mockMgrStream.mockImplementation(async function* () {
        throw new Error("provider exploded");
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker", onStreamDone });
      await expect(adapter.complete([{ role: "user", content: "test" }])).rejects.toThrow("provider exploded");
      expect(onStreamDone).toHaveBeenCalledWith({ message: "provider exploded" });
    });

    it("fires onReasoning with error message on failure", async () => {
      const onReasoning = vi.fn();
      mocks.mockMgrStream.mockImplementation(async function* () {
        throw new Error("timeout");
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker", onReasoning });
      await expect(adapter.complete([{ role: "user", content: "test" }])).rejects.toThrow();
      expect(onReasoning).toHaveBeenCalledWith("[provider error] timeout");
    });

    it("throws immediately if signal already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      await expect(
        adapter.complete([{ role: "user", content: "test" }], { signal: controller.signal }),
      ).rejects.toThrow("Aborted");
    });
  });

  /* ============================================================== */
  /*  executeTask()                                                 */
  /* ============================================================== */
  describe("executeTask()", () => {
    it("wraps task in system prompt with workspace path", async () => {
      const adapter = new UniversalWorkerAdapter({ botId: "worker", workspacePath: "/my/project" });
      await adapter.executeTask({ task_id: "t1", description: "build login", assigned_to: "worker", priority: "high", status: "pending" });

      const [, opts] = mocks.mockMgrStream.mock.calls[0]!;
      expect(opts.systemPrompt).toContain("/my/project");
    });

    it("returns TaskResult with success=true on completion", async () => {
      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      const result = await adapter.executeTask({
        task_id: "t1",
        description: "build login",
        assigned_to: "worker",
        priority: "high",
        status: "pending",
      });

      expect(result.success).toBe(true);
      expect(result.task_id).toBe("t1");
      expect(result.output).toContain("Hello world");
    });

    it("returns TaskResult with success=false on error", async () => {
      mocks.mockMgrStream.mockImplementation(async function* () {
        throw new Error("LLM down");
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      const result = await adapter.executeTask({
        task_id: "t2",
        description: "deploy",
        assigned_to: "worker",
        priority: "medium",
        status: "pending",
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("Worker error:");
      expect(result.output).toContain("LLM down");
    });
  });

  /* ============================================================== */
  /*  healthCheck()                                                 */
  /* ============================================================== */
  describe("healthCheck()", () => {
    it("returns true when provider responds", async () => {
      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      const ok = await adapter.healthCheck();
      expect(ok).toBe(true);
    });

    it("returns false when provider throws", async () => {
      mocks.mockMgrStream.mockImplementation(async function* () {
        throw new Error("dead");
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker" });
      const ok = await adapter.healthCheck();
      expect(ok).toBe(false);
    });
  });

  /* ============================================================== */
  /*  callbacks                                                     */
  /* ============================================================== */
  describe("callbacks", () => {
    it("fires onStreamChunk for each non-empty content chunk", async () => {
      const onStreamChunk = vi.fn();
      mocks.mockMgrStream.mockImplementation(async function* () {
        yield { content: "chunk1", done: false } satisfies StreamChunk;
        yield { content: "chunk2", done: false } satisfies StreamChunk;
        yield { content: "", done: true } satisfies StreamChunk;
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker", onStreamChunk });
      await adapter.complete([{ role: "user", content: "test" }]);

      expect(onStreamChunk).toHaveBeenCalledTimes(2);
      expect(onStreamChunk).toHaveBeenCalledWith("chunk1");
      expect(onStreamChunk).toHaveBeenCalledWith("chunk2");
    });

    it("fires onStreamDone when stream completes successfully", async () => {
      const onStreamDone = vi.fn();
      const adapter = new UniversalWorkerAdapter({ botId: "worker", onStreamDone });
      await adapter.complete([{ role: "user", content: "test" }]);

      expect(onStreamDone).toHaveBeenCalledTimes(1);
      expect(onStreamDone).toHaveBeenCalledWith();
    });

    it("fires onStreamDone with error when stream fails", async () => {
      const onStreamDone = vi.fn();
      mocks.mockMgrStream.mockImplementation(async function* () {
        throw new Error("stream broke");
      });

      const adapter = new UniversalWorkerAdapter({ botId: "worker", onStreamDone });
      await expect(adapter.complete([{ role: "user", content: "test" }])).rejects.toThrow();

      expect(onStreamDone).toHaveBeenCalledWith({ message: "stream broke" });
    });
  });
});
