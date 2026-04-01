import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
const { mockLogger, mockDetectDrift, mockDecisionStore, mockGlobalMemoryManager, mockVectorMemory } = vi.hoisted(() => ({
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
  mockDetectDrift: vi.fn(),
  mockDecisionStore: {
    init: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
  },
  mockGlobalMemoryManager: {
    init: vi.fn(),
    getDb: vi.fn().mockReturnValue({}),
  },
  mockVectorMemory: {
    init: vi.fn(),
    getEmbedder: vi.fn().mockReturnValue({}),
  },
}));
vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));
vi.mock("@/drift/detector.js", () => ({
  detectDrift: (...args: unknown[]) => mockDetectDrift(...args),
}));
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

import { runDriftCommand } from "@/commands/drift.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("teamclaw drift", () => {
  describe("argument parsing", () => {
    it("--help shows usage with example commands", async () => {
      await runDriftCommand(["--help"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("drift");
      expect(output).toContain("--verbose");
      expect(output).toContain("Usage:");
      expect(mockDetectDrift).not.toHaveBeenCalled();
    });

    it("no args shows usage and does not run detection", async () => {
      await runDriftCommand([]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("drift");
      expect(mockDetectDrift).not.toHaveBeenCalled();
    });
  });

  describe("drift detection", () => {
    it("reports no conflicts when drift is clean", async () => {
      mockDecisionStore.getAll.mockResolvedValue([
        {
          id: "d1",
          decision: "Use REST",
          reasoning: "Standard",
          recommendedBy: "architect",
          confidence: 0.9,
          capturedAt: Date.now(),
          sessionId: "s1",
          runIndex: 0,
          taskId: "t1",
          goalContext: "API",
          topic: "arch",
          status: "active",
          tags: [],
        },
      ]);
      mockDetectDrift.mockReturnValue({
        hasDrift: false,
        severity: "none",
        conflicts: [],
        checkedAt: Date.now(),
      });

      await runDriftCommand(["Build a REST API"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("No conflicts");
    });

    it("reports conflicts when drift is detected", async () => {
      const pastDecision = {
        id: "dec-001",
        decision: "Use MongoDB",
        reasoning: "NoSQL flexibility",
        recommendedBy: "architect",
        confidence: 0.8,
        capturedAt: Date.now() - 86400000,
        sessionId: "session-001",
        runIndex: 0,
        taskId: "task-001",
        goalContext: "Build user system",
        topic: "database",
        status: "active",
        tags: [],
      };

      mockDecisionStore.getAll.mockResolvedValue([pastDecision]);
      mockDetectDrift.mockReturnValue({
        hasDrift: true,
        severity: "soft",
        conflicts: [
          {
            decision: pastDecision,
            conflictType: "indirect",
            explanation: "New goal implies SQL but past decision chose MongoDB",
          },
        ],
        checkedAt: Date.now(),
      });

      await runDriftCommand(["Add PostgreSQL support"]);

      expect(mockDetectDrift).toHaveBeenCalled();
      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("conflict");
      expect(output).toContain("MongoDB");
    });

    it("--verbose shows additional metadata", async () => {
      mockDecisionStore.getAll.mockResolvedValue([
        {
          id: "d1",
          decision: "Use REST",
          reasoning: "Team familiarity",
          recommendedBy: "architect",
          confidence: 0.9,
          capturedAt: Date.now(),
          sessionId: "s1",
          runIndex: 0,
          taskId: "t1",
          goalContext: "API design",
          topic: "architecture",
          status: "active",
          tags: [],
        },
      ]);
      mockDetectDrift.mockReturnValue({
        hasDrift: true,
        severity: "hard",
        conflicts: [
          {
            decision: {
              decision: "Use REST",
              reasoning: "Team familiarity",
              recommendedBy: "architect",
              confidence: 0.9,
              capturedAt: Date.now(),
              sessionId: "s1",
              runIndex: 0,
              taskId: "t1",
              goalContext: "API design",
              topic: "architecture",
              status: "active",
              tags: [],
            },
            conflictType: "direct",
            explanation: "GraphQL contradicts REST decision",
          },
        ],
        checkedAt: Date.now(),
      });

      await runDriftCommand(["Switch to GraphQL", "--verbose"]);

      // Verify goal was passed correctly (--verbose stripped)
      expect(mockDetectDrift).toHaveBeenCalledWith(
        "Switch to GraphQL",
        expect.any(Array),
      );

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("direct"); // conflict type badge
      expect(output).toContain("GraphQL contradicts REST"); // explanation
      // Verbose mode shows checked-at timestamp
      expect(output).toMatch(/Checked \d+ conflict/);
    });
  });

  describe("UX: goal parsing", () => {
    it("passes multi-word goal correctly with --verbose stripped", async () => {
      mockDecisionStore.getAll.mockResolvedValue([{ id: "d1", decision: "X", reasoning: "Y", recommendedBy: "a", confidence: 0.5, capturedAt: Date.now(), sessionId: "s", runIndex: 0, taskId: "t", goalContext: "", topic: "", status: "active", tags: [] }]);
      mockDetectDrift.mockReturnValue({ hasDrift: false, severity: "none", conflicts: [], checkedAt: Date.now() });

      await runDriftCommand(["Add", "Redis", "caching", "--verbose"]);

      expect(mockDetectDrift).toHaveBeenCalledWith(
        "Add Redis caching",
        expect.any(Array),
      );
    });

    it("shows no-decisions message when journal is empty", async () => {
      mockDecisionStore.getAll.mockResolvedValue([]);

      await runDriftCommand(["Build something"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("No past decisions");
      expect(mockDetectDrift).not.toHaveBeenCalled();
    });
  });
});
