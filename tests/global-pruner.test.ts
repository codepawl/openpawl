import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { GlobalPruner } from "../src/memory/global/pruner.js";

describe("GlobalPruner", () => {
  let mockPatternStore: Record<string, ReturnType<typeof vi.fn>>;
  let mockKnowledgeGraph: Record<string, ReturnType<typeof vi.fn>>;
  let mockGlobalManager: Record<string, unknown>;
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    mockPatternStore = {
      getAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    };

    mockKnowledgeGraph = {
      pruneEdges: vi.fn().mockResolvedValue(0),
    };

    mockGlobalManager = {
      getPatternStore: vi.fn().mockReturnValue(mockPatternStore),
      getKnowledgeGraph: vi.fn().mockReturnValue(mockKnowledgeGraph),
      getAllLessons: vi.fn().mockResolvedValue([]),
      deleteLesson: vi.fn().mockResolvedValue(true),
    };
  });

  it("should prune old low-quality patterns", async () => {
    mockPatternStore.getAll.mockResolvedValue([
      {
        id: "old-bad",
        confidence: 0.2,
        createdAt: now - 200 * oneDay,
        promotedBy: "auto",
      },
      {
        id: "old-good",
        confidence: 0.9,
        createdAt: now - 200 * oneDay,
        promotedBy: "auto",
      },
    ]);

    const pruner = new GlobalPruner(mockGlobalManager as never);
    const result = await pruner.prune();

    expect(result.patternsRemoved).toBe(1);
    expect(mockPatternStore.delete).toHaveBeenCalledWith("old-bad");
  });

  it("should never prune user-promoted patterns", async () => {
    mockPatternStore.getAll.mockResolvedValue([
      {
        id: "user-old",
        confidence: 0.1,
        createdAt: now - 365 * oneDay,
        promotedBy: "user",
      },
    ]);

    const pruner = new GlobalPruner(mockGlobalManager as never);
    const result = await pruner.prune();

    expect(result.patternsRemoved).toBe(0);
    expect(mockPatternStore.delete).not.toHaveBeenCalled();
  });

  it("should prune stale patterns (old + low quality)", async () => {
    mockPatternStore.getAll.mockResolvedValue([
      {
        id: "stale",
        confidence: 0.4,
        createdAt: now - 90 * oneDay,
        promotedBy: "auto",
      },
    ]);

    const pruner = new GlobalPruner(mockGlobalManager as never);
    const result = await pruner.prune();

    expect(result.patternsRemoved).toBe(1);
  });

  it("should prune old unused lessons", async () => {
    (mockGlobalManager.getAllLessons as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "lesson-old",
        createdAt: now - 200 * oneDay,
        retrievalCount: 0,
        helpedAvoidFailure: false,
        promotedBy: "auto",
      },
      {
        id: "lesson-useful",
        createdAt: now - 200 * oneDay,
        retrievalCount: 5,
        helpedAvoidFailure: true,
        promotedBy: "auto",
      },
    ]);

    const pruner = new GlobalPruner(mockGlobalManager as never);
    const result = await pruner.prune();

    expect(result.lessonsRemoved).toBe(1);
    expect(mockGlobalManager.deleteLesson).toHaveBeenCalledWith("lesson-old");
  });

  it("should clean orphaned knowledge graph edges", async () => {
    mockPatternStore.getAll.mockResolvedValue([
      { id: "keep", confidence: 0.9, createdAt: now, promotedBy: "auto" },
    ]);
    mockKnowledgeGraph.pruneEdges.mockResolvedValue(3);

    const pruner = new GlobalPruner(mockGlobalManager as never);
    const result = await pruner.prune();

    expect(result.edgesRemoved).toBe(3);
    expect(mockKnowledgeGraph.pruneEdges).toHaveBeenCalled();
  });

  it("should accept custom thresholds", async () => {
    mockPatternStore.getAll.mockResolvedValue([
      {
        id: "pat-1",
        confidence: 0.4,
        createdAt: now - 100 * oneDay,
        promotedBy: "auto",
      },
    ]);

    const pruner = new GlobalPruner(mockGlobalManager as never);
    // With maxAgeDays=50, this should be pruned
    const result = await pruner.prune({ maxAgeDays: 50, minQuality: 0.5 });
    expect(result.patternsRemoved).toBe(1);
  });
});
