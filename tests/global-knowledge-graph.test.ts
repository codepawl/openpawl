import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { KnowledgeGraphStore } from "../src/memory/global/knowledge-graph.js";
import type { GlobalSuccessPattern, KnowledgeEdge } from "../src/memory/global/types.js";

function makeGlobalPattern(overrides: Partial<GlobalSuccessPattern> = {}): GlobalSuccessPattern {
  return {
    id: `pat-${Math.random().toString(36).slice(2)}`,
    sessionId: "session-1",
    taskDescription: "Test task",
    agentRole: "worker",
    approach: "Direct approach",
    resultSummary: "Success",
    confidence: 0.9,
    approvalType: "auto",
    reworkCount: 0,
    goalContext: "Test",
    tags: ["test"],
    createdAt: Date.now(),
    runIndex: 1,
    promotedAt: Date.now(),
    promotedBy: "auto",
    sourceSessionId: "session-1",
    globalQualityScore: 0.85,
    ...overrides,
  };
}

describe("KnowledgeGraphStore", () => {
  let mockDb: Record<string, unknown>;
  let mockTable: Record<string, unknown>;
  let storedRows: Array<Record<string, unknown>>;

  beforeEach(() => {
    storedRows = [];

    mockTable = {
      add: vi.fn().mockImplementation(async (rows: Array<Record<string, unknown>>) => {
        storedRows.push(...rows);
      }),
      delete: vi.fn().mockImplementation(async (filter: string) => {
        const idMatch = filter.match(/id = '([^']+)'/);
        if (idMatch) {
          storedRows = storedRows.filter((r) => r.id !== idMatch[1]);
        }
      }),
      countRows: vi.fn().mockImplementation(() => Promise.resolve(storedRows.length)),
      query: vi.fn().mockReturnValue({
        toArray: vi.fn().mockImplementation(() => Promise.resolve(storedRows)),
      }),
    };

    mockDb = {
      tableNames: vi.fn().mockResolvedValue([]),
      createTable: vi.fn().mockImplementation(async (_name: string, rows: Array<Record<string, unknown>>) => {
        storedRows.push(...rows);
        return mockTable;
      }),
      openTable: vi.fn().mockResolvedValue(mockTable),
    };
  });

  it("should add and retrieve edges", async () => {
    const store = new KnowledgeGraphStore(mockDb as never);
    await store.init();

    const edge: KnowledgeEdge = {
      id: "edge-1",
      fromPatternId: "pat-a",
      toPatternId: "pat-b",
      relationship: "similar_to",
      strength: 0.9,
      observedCount: 1,
      createdAt: Date.now(),
    };

    const ok = await store.addEdge(edge);
    expect(ok).toBe(true);

    const edges = await store.getEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("similar_to");
  });

  it("should filter edges by nodeId", async () => {
    const store = new KnowledgeGraphStore(mockDb as never);
    await store.init();

    storedRows = [
      { id: "e1", from_pattern_id: "a", to_pattern_id: "b", relationship: "similar_to", strength: 0.9, observed_count: 1, created_at: Date.now(), vector: [0] },
      { id: "e2", from_pattern_id: "c", to_pattern_id: "d", relationship: "leads_to", strength: 0.7, observed_count: 1, created_at: Date.now(), vector: [0] },
    ];
    // Need to mark table as existing
    (mockDb.tableNames as ReturnType<typeof vi.fn>).mockResolvedValue(["global_knowledge_graph"]);
    await store.init();

    const edges = await store.getEdges("a");
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe("e1");
  });

  it("should enforce graph limit in getGraph", async () => {
    const store = new KnowledgeGraphStore(mockDb as never);
    (mockDb.tableNames as ReturnType<typeof vi.fn>).mockResolvedValue(["global_knowledge_graph"]);
    await store.init();

    // Add many edges pointing to unique nodes
    storedRows = [];
    for (let i = 0; i < 10; i++) {
      storedRows.push({
        id: `e${i}`,
        from_pattern_id: `node-${i * 2}`,
        to_pattern_id: `node-${i * 2 + 1}`,
        relationship: "similar_to",
        strength: 0.9,
        observed_count: 1,
        created_at: Date.now(),
        vector: [0],
      });
    }

    const graph = await store.getGraph(5);
    expect(graph.nodes.length).toBeLessThanOrEqual(5);
  });

  it("should prune orphaned edges", async () => {
    const store = new KnowledgeGraphStore(mockDb as never);
    (mockDb.tableNames as ReturnType<typeof vi.fn>).mockResolvedValue(["global_knowledge_graph"]);
    await store.init();

    storedRows = [
      { id: "e1", from_pattern_id: "valid-a", to_pattern_id: "valid-b", relationship: "similar_to", strength: 0.9, observed_count: 1, created_at: Date.now(), vector: [0] },
      { id: "e2", from_pattern_id: "valid-a", to_pattern_id: "orphan-c", relationship: "leads_to", strength: 0.7, observed_count: 1, created_at: Date.now(), vector: [0] },
    ];

    const validIds = new Set(["valid-a", "valid-b"]);
    const removed = await store.pruneEdges(validIds);
    expect(removed).toBe(1);
  });

  it("should short-circuit rebuild for >500 patterns", async () => {
    const store = new KnowledgeGraphStore(mockDb as never);
    await store.init();

    const patterns = Array.from({ length: 501 }, (_, i) =>
      makeGlobalPattern({ id: `pat-${i}` }),
    );
    const mockEmbedder = { generate: vi.fn() };

    const count = await store.rebuildEdges(patterns, mockEmbedder as never);
    expect(count).toBe(0);
    expect(mockEmbedder.generate).not.toHaveBeenCalled();
  });
});
