import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
const { mockLogger, mockDecisionStore, mockGlobalMemoryManager, mockVectorMemory } = vi.hoisted(() => ({
  mockLogger: {
    plain: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    agent: vi.fn(),
    plainLine: vi.fn(),
  },
  mockDecisionStore: {
    init: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    getRecentDecisions: vi.fn().mockResolvedValue([]),
    getDecisionsBySession: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    searchDecisions: vi.fn().mockResolvedValue([]),
    reconsider: vi.fn(),
    markReconsidered: vi.fn().mockResolvedValue(true),
    markPermanent: vi.fn().mockResolvedValue(true),
    unmarkPermanent: vi.fn().mockResolvedValue(true),
  },
  mockGlobalMemoryManager: {
    init: vi.fn(),
    getDb: vi.fn().mockReturnValue({}),
  },
  mockVectorMemory: {
    init: vi.fn(),
    getEmbedder: vi.fn().mockReturnValue({}),
    getDb: vi.fn().mockReturnValue({}),
  },
}));
vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));
vi.mock("@/journal/store.js", () => ({
  DecisionStore: vi.fn().mockImplementation(() => mockDecisionStore),
}));
vi.mock("@/memory/global/store.js", () => ({
  GlobalMemoryManager: vi.fn().mockImplementation(() => mockGlobalMemoryManager),
}));
vi.mock("@/core/knowledge-base.js", () => ({
  VectorMemory: vi.fn().mockImplementation(() => mockVectorMemory),
}));

vi.mock("@/core/config.js", () => ({
  CONFIG: {
    vectorStorePath: "/tmp/test-vectors",
    memoryBackend: "local_json",
  },
}));

import { runJournalCommand } from "@/commands/journal.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockVectorMemory.getEmbedder.mockReturnValue({});
  mockGlobalMemoryManager.getDb.mockReturnValue({});
});

const sampleDecision = {
  id: "dec-001",
  decision: "Use PostgreSQL for persistence",
  reasoning: "Better ACID compliance for transactional data",
  recommendedBy: "architect",
  confidence: 0.85,
  capturedAt: Date.now() - 86400000,
  sessionId: "session-abc123def456",
  runIndex: 0,
  taskId: "task-001",
  goalContext: "Build a user management system",
  topic: "database",
  status: "active" as const,
  tags: ["database", "persistence"],
};

describe("teamclaw journal", () => {
  describe("argument parsing", () => {
    it("--help shows usage with all subcommands", async () => {
      await runJournalCommand(["--help"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("journal");
      expect(output).toContain("list");
      expect(output).toContain("search");
      expect(output).toContain("show");
      expect(output).toContain("reconsider");
      expect(output).toContain("export");
    });

    it("unknown subcommand shows error", async () => {
      await runJournalCommand(["bogus"]);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Unknown journal subcommand"),
      );
    });
  });

  describe("journal list subcommand", () => {
    it("shows empty message when no decisions exist", async () => {
      mockDecisionStore.getAll.mockResolvedValue([]);

      await runJournalCommand(["list"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("No decisions");
    });

    it("lists decisions when they exist", async () => {
      mockDecisionStore.getAll.mockResolvedValue([sampleDecision]);

      await runJournalCommand(["list"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("PostgreSQL");
    });

    it("--since 7d filters by recency", async () => {
      mockDecisionStore.getRecentDecisions.mockResolvedValue([sampleDecision]);

      await runJournalCommand(["list", "--since", "7d"]);

      expect(mockDecisionStore.getRecentDecisions).toHaveBeenCalledWith(7);
    });

    it("--since 2w parses weeks correctly", async () => {
      mockDecisionStore.getRecentDecisions.mockResolvedValue([]);

      await runJournalCommand(["list", "--since", "2w"]);

      expect(mockDecisionStore.getRecentDecisions).toHaveBeenCalledWith(14);
    });

    it("--session filters by session ID", async () => {
      mockDecisionStore.getDecisionsBySession.mockResolvedValue([sampleDecision]);

      await runJournalCommand(["list", "--session", "session-abc123"]);

      expect(mockDecisionStore.getDecisionsBySession).toHaveBeenCalledWith("session-abc123");
    });

    it("--agent filters by agent name and excludes non-matching", async () => {
      mockDecisionStore.getAll.mockResolvedValue([
        sampleDecision,
        { ...sampleDecision, id: "dec-002", decision: "Use React for frontend", recommendedBy: "developer" },
      ]);

      await runJournalCommand(["list", "--agent", "architect"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("PostgreSQL"); // architect's decision
      expect(output).not.toContain("React"); // developer's decision excluded
      expect(output).toContain("1 decision(s)"); // count reflects filtered set
    });
  });

  describe("journal search subcommand", () => {
    it("searches with query text", async () => {
      mockDecisionStore.searchDecisions.mockResolvedValue([sampleDecision]);

      await runJournalCommand(["search", "database"]);

      expect(mockDecisionStore.searchDecisions).toHaveBeenCalledWith("database");
    });

    it("errors when no query is provided", async () => {
      await runJournalCommand(["search"]);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
      );
    });
  });

  describe("journal show subcommand", () => {
    it("displays full decision details by ID", async () => {
      mockDecisionStore.getById.mockResolvedValue(sampleDecision);

      await runJournalCommand(["show", "dec-001"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("PostgreSQL");
      expect(output).toContain("architect");
    });

    it("errors when decision is not found", async () => {
      mockDecisionStore.getById.mockResolvedValue(null);
      mockDecisionStore.getDecisionsBySession.mockResolvedValue([]);

      await runJournalCommand(["show", "nonexistent"]);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("No decision or session found"),
      );
    });
  });

  describe("UX: decision display formatting", () => {
    it("list shows date, decision text, agent name, and confidence %", async () => {
      mockDecisionStore.getAll.mockResolvedValue([sampleDecision]);

      await runJournalCommand(["list"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("PostgreSQL"); // decision text
      expect(output).toContain("architect"); // recommended by
      expect(output).toContain("85%"); // confidence as percentage
    });

    it("show displays full details including reasoning and goal context", async () => {
      mockDecisionStore.getById.mockResolvedValue(sampleDecision);

      await runJournalCommand(["show", "dec-001"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("ACID compliance"); // reasoning
      expect(output).toContain("user management"); // goal context
      expect(output).toContain("database"); // topic
    });

    it("show falls back to session ID lookup when decision ID not found", async () => {
      mockDecisionStore.getById.mockResolvedValue(null);
      mockDecisionStore.getDecisionsBySession.mockResolvedValue([sampleDecision]);

      await runJournalCommand(["show", "session-abc123def456"]);

      expect(mockDecisionStore.getDecisionsBySession).toHaveBeenCalledWith("session-abc123def456");
      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("1 decision(s) from session");
      expect(output).toContain("PostgreSQL");
    });

    it("search shows count of results found", async () => {
      mockDecisionStore.searchDecisions.mockResolvedValue([
        sampleDecision,
        { ...sampleDecision, id: "dec-002", decision: "Index database tables" },
      ]);

      await runJournalCommand(["search", "database"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("2 decision(s) found");
    });

    it("search shows 'no decisions found' for empty results", async () => {
      mockDecisionStore.searchDecisions.mockResolvedValue([]);

      await runJournalCommand(["search", "nonexistent"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("No decisions found");
    });
  });

  describe("store initialization failure", () => {
    it("reports error when embedder is not available", async () => {
      mockVectorMemory.getEmbedder.mockReturnValue(null);

      await runJournalCommand(["list"]);

      const output = [
        ...mockLogger.error.mock.calls,
        ...mockLogger.plain.mock.calls,
      ].map((c: unknown[]) => String(c[0])).join("\n");
      expect(output.toLowerCase()).toMatch(/could not initialize|not available|setup/i);
    });
  });
});
