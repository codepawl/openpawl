import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClarityHistoryStore } from "./history.js";
import type { ClarityHistoryEntry, ClarityIssueType } from "./types.js";

function makeEntry(overrides: Partial<ClarityHistoryEntry> = {}): ClarityHistoryEntry {
  return {
    sessionId: "sess-1",
    originalGoal: "Improve the API",
    clarityScore: 0.4,
    issues: [],
    resolution: "proceeded",
    ignoredIssueTypes: [],
    recordedAt: Date.now(),
    ...overrides,
  };
}

// Mock lancedb table
function makeMockDb() {
  const rows: Array<Record<string, unknown>> = [];
  const table = {
    add: vi.fn(async (newRows: Array<Record<string, unknown>>) => {
      rows.push(...newRows);
    }),
    query: vi.fn(() => ({
      toArray: vi.fn(async () => rows),
    })),
  };
  const db = {
    tableNames: vi.fn(async () => rows.length > 0 ? ["clarity_history"] : []),
    openTable: vi.fn(async () => table),
    createTable: vi.fn(async (_name: string, data: Array<Record<string, unknown>>) => {
      rows.push(...data);
      return table;
    }),
  };
  return { db, table, rows };
}

describe("ClarityHistoryStore", () => {
  let store: ClarityHistoryStore;
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    store = new ClarityHistoryStore();
    mockDb = makeMockDb();
  });

  it("records an entry", async () => {
    await store.init(mockDb.db as never);
    const entry = makeEntry();
    const success = await store.record(entry);
    expect(success).toBe(true);
  });

  it("records ignored issue types correctly", async () => {
    await store.init(mockDb.db as never);
    const entry = makeEntry({
      ignoredIssueTypes: ["vague_verb", "missing_success_criteria"],
    });
    const success = await store.record(entry);
    expect(success).toBe(true);
    // Verify the row was stored with the ignored types
    expect(mockDb.rows.length).toBeGreaterThan(0);
    const row = mockDb.rows[0]!;
    const parsed = JSON.parse(String(row.ignored_issue_types_json));
    expect(parsed).toContain("vague_verb");
    expect(parsed).toContain("missing_success_criteria");
  });

  it("getLearnedIgnores returns types ignored >= 5 times", async () => {
    // Pre-populate rows with 5 entries ignoring vague_verb
    for (let i = 0; i < 5; i++) {
      mockDb.rows.push({
        id: `clarity-${i}`,
        session_id: `sess-${i}`,
        original_goal: "test",
        clarified_goal: "",
        clarity_score: 0.5,
        issues_json: "[]",
        resolution: "proceeded",
        ignored_issue_types_json: JSON.stringify(["vague_verb" as ClarityIssueType]),
        recorded_at: Date.now() - i * 1000,
        vector: [0],
      });
    }
    // Add 3 entries ignoring unspecified_noun (not enough)
    for (let i = 0; i < 3; i++) {
      mockDb.rows.push({
        id: `clarity-extra-${i}`,
        session_id: `sess-extra-${i}`,
        original_goal: "test",
        clarified_goal: "",
        clarity_score: 0.5,
        issues_json: "[]",
        resolution: "proceeded",
        ignored_issue_types_json: JSON.stringify(["unspecified_noun" as ClarityIssueType]),
        recorded_at: Date.now() - i * 1000,
        vector: [0],
      });
    }

    // Need to re-init so it opens the existing table
    const dbWithTable = {
      ...mockDb.db,
      tableNames: vi.fn(async () => ["clarity_history"]),
    };
    await store.init(dbWithTable as never);

    const learned = await store.getLearnedIgnores();
    expect(learned).toContain("vague_verb");
    expect(learned).not.toContain("unspecified_noun");
  });

  it("stops showing issue type after 5 ignored occurrences", async () => {
    // This tests the integration: after 5 ignores, the type should be in learned ignores
    for (let i = 0; i < 6; i++) {
      mockDb.rows.push({
        id: `clarity-${i}`,
        session_id: `sess-${i}`,
        original_goal: "test",
        clarified_goal: "",
        clarity_score: 0.5,
        issues_json: "[]",
        resolution: "proceeded",
        ignored_issue_types_json: JSON.stringify(["missing_success_criteria" as ClarityIssueType]),
        recorded_at: Date.now() - i * 1000,
        vector: [0],
      });
    }

    const dbWithTable = {
      ...mockDb.db,
      tableNames: vi.fn(async () => ["clarity_history"]),
    };
    await store.init(dbWithTable as never);

    const learned = await store.getLearnedIgnores();
    expect(learned).toContain("missing_success_criteria");
  });

  it("returns false when db is not initialized", async () => {
    // Don't init the store
    const success = await store.record(makeEntry());
    expect(success).toBe(false);
  });
});
