import { describe, it, expect, beforeEach, vi } from "vitest";
import { DecisionStore } from "./store.js";
import type { Decision } from "./types.js";

// Mock lancedb
const mockRows: Record<string, unknown>[] = [];
const mockTable = {
  query: () => ({
    toArray: async () => [...mockRows],
  }),
  delete: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockImplementation(async (rows: Record<string, unknown>[]) => {
    mockRows.push(...rows);
  }),
  countRows: vi.fn().mockImplementation(async () => mockRows.length),
};
const mockDb = {
  tableNames: vi.fn().mockResolvedValue(["decisions"]),
  openTable: vi.fn().mockResolvedValue(mockTable),
  createTable: vi.fn().mockImplementation(async (_name: string, rows: Record<string, unknown>[]) => {
    mockRows.push(...rows);
    return mockTable;
  }),
};

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec-1",
    sessionId: "sess-123",
    runIndex: 1,
    capturedAt: Date.now(),
    topic: "OAuth flow",
    decision: "Use PKCE flow",
    reasoning: "More secure than implicit",
    recommendedBy: "tech_lead",
    confidence: 0.91,
    taskId: "t-1",
    goalContext: "Build auth",
    tags: ["oauth", "auth"],
    embedding: [],
    status: "active",
    ...overrides,
  };
}

describe("DecisionStore", () => {
  let store: DecisionStore;

  beforeEach(async () => {
    mockRows.length = 0;
    vi.clearAllMocks();
    store = new DecisionStore();
    await store.init(mockDb as unknown as import("@lancedb/lancedb").Connection);
  });

  it("upserts a decision without duplicates", async () => {
    const d = makeDecision();
    await store.upsert(d);
    await store.upsert(d); // second upsert should delete + re-add
    expect(mockTable.delete).toHaveBeenCalled();
  });

  it("gets decision by ID", async () => {
    const d = makeDecision({ id: "unique-dec" });
    // Manually put in mockRows to simulate stored state
    mockRows.push({
      id: "unique-dec",
      session_id: d.sessionId,
      run_index: d.runIndex,
      captured_at: d.capturedAt,
      topic: d.topic,
      decision: d.decision,
      reasoning: d.reasoning,
      recommended_by: d.recommendedBy,
      confidence: d.confidence,
      task_id: d.taskId,
      goal_context: d.goalContext,
      tags: JSON.stringify(d.tags),
      status: d.status,
      superseded_by: "",
      vector: [0],
    });

    const result = await store.getById("unique-dec");
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("Use PKCE flow");
  });

  it("keyword search returns correct matches", async () => {
    mockRows.push(
      {
        id: "d1", topic: "OAuth", decision: "Use PKCE flow",
        reasoning: "Secure", recommended_by: "tech_lead", confidence: 0.9,
        session_id: "s1", run_index: 1, captured_at: Date.now(),
        task_id: "t1", goal_context: "Auth", tags: '["oauth"]',
        status: "active", superseded_by: "", vector: [0],
      },
      {
        id: "d2", topic: "Database", decision: "Use PostgreSQL",
        reasoning: "ACID compliance", recommended_by: "coordinator", confidence: 0.85,
        session_id: "s1", run_index: 1, captured_at: Date.now(),
        task_id: "t2", goal_context: "Data layer", tags: '["database"]',
        status: "active", superseded_by: "", vector: [0],
      },
    );

    const results = await store.searchDecisions("OAuth");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.decision).toContain("PKCE");
  });

  it("keyword search returns empty for unmatched query", async () => {
    mockRows.push({
      id: "d1", topic: "OAuth", decision: "Use PKCE",
      reasoning: "Secure", recommended_by: "tech_lead", confidence: 0.9,
      session_id: "s1", run_index: 1, captured_at: Date.now(),
      task_id: "t1", goal_context: "Auth", tags: '["oauth"]',
      status: "active", superseded_by: "", vector: [0],
    });

    const results = await store.searchDecisions("kubernetes");
    expect(results).toHaveLength(0);
  });

  it("getDecisionsBySession filters correctly", async () => {
    mockRows.push(
      {
        id: "d1", session_id: "sess-A", decision: "Use X",
        topic: "T", reasoning: "R", recommended_by: "tech_lead",
        confidence: 0.9, run_index: 1, captured_at: Date.now(),
        task_id: "t1", goal_context: "G", tags: "[]",
        status: "active", superseded_by: "", vector: [0],
      },
      {
        id: "d2", session_id: "sess-B", decision: "Use Y",
        topic: "T", reasoning: "R", recommended_by: "tech_lead",
        confidence: 0.9, run_index: 1, captured_at: Date.now(),
        task_id: "t2", goal_context: "G", tags: "[]",
        status: "active", superseded_by: "", vector: [0],
      },
    );

    const results = await store.getDecisionsBySession("sess-A");
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("d1");
  });

  it("getRecentDecisions returns only within time range", async () => {
    const now = Date.now();
    mockRows.push(
      {
        id: "recent", session_id: "s", decision: "D1",
        topic: "T", reasoning: "R", recommended_by: "tech_lead",
        confidence: 0.9, run_index: 1, captured_at: now,
        task_id: "t1", goal_context: "G", tags: "[]",
        status: "active", superseded_by: "", vector: [0],
      },
      {
        id: "old", session_id: "s", decision: "D2",
        topic: "T", reasoning: "R", recommended_by: "tech_lead",
        confidence: 0.9, run_index: 1, captured_at: now - 30 * 24 * 60 * 60 * 1000,
        task_id: "t2", goal_context: "G", tags: "[]",
        status: "active", superseded_by: "", vector: [0],
      },
    );

    const results = await store.getRecentDecisions(7);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("recent");
  });

  it("marks decision as superseded", async () => {
    mockRows.push({
      id: "old-dec", session_id: "s", decision: "Use X",
      topic: "T", reasoning: "R", recommended_by: "tech_lead",
      confidence: 0.9, run_index: 1, captured_at: Date.now(),
      task_id: "t1", goal_context: "G", tags: "[]",
      status: "active", superseded_by: "", vector: [0],
    });

    await store.supersede("old-dec", "new-dec");
    // Verify delete was called (supersede does upsert which deletes first)
    expect(mockTable.delete).toHaveBeenCalled();
  });

  it("marks decision as reconsidered", async () => {
    mockRows.push({
      id: "dec-r", session_id: "s", decision: "Use X",
      topic: "T", reasoning: "R", recommended_by: "tech_lead",
      confidence: 0.9, run_index: 1, captured_at: Date.now(),
      task_id: "t1", goal_context: "G", tags: "[]",
      status: "active", superseded_by: "", vector: [0],
    });

    const ok = await store.markReconsidered("dec-r");
    expect(ok).toBe(true);
  });
});
