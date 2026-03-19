import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
  isDebugMode: () => false,
}));

// Hoist mock state so it's available during vi.mock factory execution
const {
  mockToArray,
  mockLimit,
  mockVectorSearch,
  mockAdd,
  mockTable,
  mockCreateTable,
  mockOpenTable,
  mockTableNames,
  mockConnect,
  mockGenerate,
} = vi.hoisted(() => {
  const mockToArray = vi.fn().mockResolvedValue([]);
  const mockLimit = vi.fn().mockReturnValue({ toArray: mockToArray });
  const mockDistanceType = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockVectorSearch = vi.fn().mockReturnValue({ distanceType: mockDistanceType });
  const mockAdd = vi.fn().mockResolvedValue(undefined);
  const mockTable = {
    vectorSearch: mockVectorSearch,
    add: mockAdd,
  };
  const mockCreateTable = vi.fn().mockResolvedValue(mockTable);
  const mockOpenTable = vi.fn().mockResolvedValue(mockTable);
  const mockTableNames = vi.fn().mockResolvedValue(["semantic_cache"]);
  const mockConnect = vi.fn().mockResolvedValue({
    createTable: mockCreateTable,
    openTable: mockOpenTable,
    tableNames: mockTableNames,
  });
  const mockGenerate = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);

  return {
    mockToArray,
    mockLimit,
    mockVectorSearch,
    mockAdd,
    mockTable,
    mockCreateTable,
    mockOpenTable,
    mockTableNames,
    mockConnect,
    mockGenerate,
  };
});

vi.mock("@lancedb/lancedb", () => ({
  connect: mockConnect,
}));

vi.mock("../src/core/knowledge-base.js", () => ({
  HttpEmbeddingFunction: vi.fn().mockImplementation(() => ({
    generate: mockGenerate,
  })),
}));

import { SemanticCache, resetSemanticCache } from "../src/token-opt/semantic-cache.js";
import { resetTokenOptStats, getTokenOptStats } from "../src/token-opt/stats.js";

describe("SemanticCache", () => {
  let cache: SemanticCache;

  beforeEach(() => {
    resetSemanticCache();
    resetTokenOptStats();
    vi.clearAllMocks();
    mockToArray.mockResolvedValue([]);
    mockTableNames.mockResolvedValue(["semantic_cache"]);
    mockGenerate.mockResolvedValue([[0.1, 0.2, 0.3]]);
    mockOpenTable.mockResolvedValue(mockTable);
    cache = new SemanticCache();
  });

  it("returns null on miss", async () => {
    await cache.init();
    const result = await cache.lookup("test prompt", "model", "worker");
    expect(result).toBeNull();
    const stats = getTokenOptStats();
    expect(stats.semanticCacheMisses).toBe(1);
  });

  it("returns cached response on high similarity", async () => {
    const now = Date.now();
    mockToArray.mockResolvedValue([
      {
        id: "sc-1",
        role: "worker",
        model: "sonnet",
        response: "cached response",
        created_at: now,
        expires_at: now + 30 * 60 * 1000,
        vector: [0.1, 0.2, 0.3],
        _distance: 0.01, // very close → similarity ~0.995
      },
    ]);

    await cache.init();
    const result = await cache.lookup("test prompt", "sonnet", "worker");
    expect(result).toBe("cached response");
    const stats = getTokenOptStats();
    expect(stats.semanticCacheHits).toBe(1);
  });

  it("returns null when similarity is below threshold", async () => {
    const now = Date.now();
    mockToArray.mockResolvedValue([
      {
        id: "sc-1",
        role: "worker",
        model: "sonnet",
        response: "cached response",
        created_at: now,
        expires_at: now + 30 * 60 * 1000,
        vector: [0.1, 0.2, 0.3],
        _distance: 0.5, // similarity ~0.75, below 0.92 threshold
      },
    ]);

    await cache.init();
    const result = await cache.lookup("test prompt", "sonnet", "worker");
    expect(result).toBeNull();
    expect(getTokenOptStats().semanticCacheMisses).toBe(1);
  });

  it("returns null after TTL expires", async () => {
    const now = Date.now();
    mockToArray.mockResolvedValue([
      {
        id: "sc-1",
        role: "worker",
        model: "sonnet",
        response: "cached response",
        created_at: now - 60 * 60 * 1000,
        expires_at: now - 1, // expired
        vector: [0.1, 0.2, 0.3],
        _distance: 0.01,
      },
    ]);

    await cache.init();
    const result = await cache.lookup("test prompt", "sonnet", "worker");
    expect(result).toBeNull();
  });

  it("returns null when agent role does not match", async () => {
    const now = Date.now();
    mockToArray.mockResolvedValue([
      {
        id: "sc-1",
        role: "coordinator", // different from lookup role
        model: "sonnet",
        response: "cached response",
        created_at: now,
        expires_at: now + 30 * 60 * 1000,
        vector: [0.1, 0.2, 0.3],
        _distance: 0.01,
      },
    ]);

    await cache.init();
    const result = await cache.lookup("test prompt", "sonnet", "worker");
    expect(result).toBeNull();
  });

  it("returns null when model does not match", async () => {
    const now = Date.now();
    mockToArray.mockResolvedValue([
      {
        id: "sc-1",
        role: "worker",
        model: "claude-sonnet-4-6", // different from lookup model
        response: "cached response",
        created_at: now,
        expires_at: now + 30 * 60 * 1000,
        vector: [0.1, 0.2, 0.3],
        _distance: 0.01,
      },
    ]);

    await cache.init();
    const result = await cache.lookup("test prompt", "gpt-4o-mini", "worker");
    expect(result).toBeNull();
  });

  it("stores and sets up table on first store", async () => {
    mockTableNames.mockResolvedValue([]); // no existing table
    cache = new SemanticCache();
    await cache.init();
    await cache.store("test prompt", "model", "worker", "response text");
    expect(mockCreateTable).toHaveBeenCalledWith(
      "semantic_cache",
      expect.arrayContaining([
        expect.objectContaining({
          role: "worker",
          model: "model",
          response: "response text",
        }),
      ]),
    );
  });

  it("bypasses prompts with session-specific content", async () => {
    await cache.init();
    const uuidPrompt = "Process task abc12345-abcd-1234-abcd-123456789012";
    const result = await cache.lookup(uuidPrompt, "model", "worker");
    expect(result).toBeNull();
    // Should not have called vectorSearch since it was bypassed
    expect(mockVectorSearch).not.toHaveBeenCalled();
  });

  it("isEnabled returns false when TEAMCLAW_NO_CACHE is set", () => {
    const original = process.env.TEAMCLAW_NO_CACHE;
    process.env.TEAMCLAW_NO_CACHE = "true";
    try {
      expect(cache.isEnabled()).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.TEAMCLAW_NO_CACHE = original;
      } else {
        delete process.env.TEAMCLAW_NO_CACHE;
      }
    }
  });

  it("isEnabled returns false when TEAMCLAW_NO_SEMANTIC_CACHE is set", () => {
    const original = process.env.TEAMCLAW_NO_SEMANTIC_CACHE;
    process.env.TEAMCLAW_NO_SEMANTIC_CACHE = "true";
    try {
      expect(cache.isEnabled()).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.TEAMCLAW_NO_SEMANTIC_CACHE = original;
      } else {
        delete process.env.TEAMCLAW_NO_SEMANTIC_CACHE;
      }
    }
  });

  it("builds cache input with role prefix for role-scoped caching", async () => {
    await cache.init();
    await cache.store("write tests", "model", "tester", "test response");
    // Verify the embedding was generated with role prefix
    expect(mockGenerate).toHaveBeenCalledWith(["[role:tester] write tests"]);
  });
});
