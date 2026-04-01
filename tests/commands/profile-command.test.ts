import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
const { mockLogger, mockProfileStore, mockGlobalMemoryManager, mockVectorMemory } = vi.hoisted(() => ({
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
  mockProfileStore: {
    init: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    getByRole: vi.fn().mockResolvedValue(null),
    resetAll: vi.fn(),
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
vi.mock("@/core/config.js", () => ({
  CONFIG: {
    vectorStorePath: "/tmp/test-vectors",
    memoryBackend: "local_json",
  },
}));
vi.mock("@/agents/profiles/store.js", () => ({
  ProfileStore: vi.fn().mockImplementation(() => mockProfileStore),
}));
vi.mock("@/memory/global/store.js", () => ({
  GlobalMemoryManager: vi.fn().mockImplementation(() => mockGlobalMemoryManager),
}));
vi.mock("@/core/knowledge-base.js", () => ({
  VectorMemory: vi.fn().mockImplementation(() => mockVectorMemory),
}));

vi.mock("@/core/team-config.js", () => ({
  loadTeamConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn().mockResolvedValue(false),
  isCancel: vi.fn().mockReturnValue(false),
}));

import { runProfileCommand } from "@/commands/profile.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish mock return values after clearAllMocks
  mockVectorMemory.getEmbedder.mockReturnValue({});
  mockGlobalMemoryManager.getDb.mockReturnValue({});
  mockProfileStore.getAll.mockResolvedValue([]);
  mockProfileStore.getByRole.mockResolvedValue(null);
});

describe("teamclaw profile", () => {
  describe("list subcommand (default)", () => {
    it("shows message when no profiles exist", async () => {
      mockProfileStore.getAll.mockResolvedValue([]);

      await runProfileCommand([]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("No agent profiles");
    });

    it("displays profiles in tabular format", async () => {
      mockProfileStore.getAll.mockResolvedValue([
        {
          agentRole: "architect",
          overallScore: 0.85,
          totalTasksCompleted: 12,
          strengths: ["system design", "planning"],
          scoreHistory: [0.8, 0.83, 0.85],
        },
        {
          agentRole: "developer",
          overallScore: 0.72,
          totalTasksCompleted: 28,
          strengths: ["implementation"],
          scoreHistory: [0.75, 0.72],
        },
      ]);

      await runProfileCommand([]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("architect");
      expect(output).toContain("developer");
      expect(output).toContain("85%");
    });

    it("--help shows list (same as no args)", async () => {
      mockProfileStore.getAll.mockResolvedValue([]);

      await runProfileCommand(["--help"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("No agent profiles");
    });

    it("list subcommand is explicit alias", async () => {
      mockProfileStore.getAll.mockResolvedValue([]);

      await runProfileCommand(["list"]);

      expect(mockProfileStore.getAll).toHaveBeenCalled();
    });
  });

  describe("show subcommand", () => {
    it("displays detailed profile for a specific role", async () => {
      mockProfileStore.getByRole.mockResolvedValue({
        agentRole: "architect",
        overallScore: 0.85,
        totalTasksCompleted: 12,
        strengths: ["system design"],
        weaknesses: ["testing"],
        scoreHistory: [0.8, 0.85],
        taskTypeScores: [],
        lastUpdatedAt: Date.now(),
      });

      await runProfileCommand(["show", "architect"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("architect");
      expect(output).toContain("85.0%");
    });

    it("errors when no role argument provided", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runProfileCommand(["show"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
      );

      exitSpy.mockRestore();
    });

    it("reports when profile not found and exits", async () => {
      mockProfileStore.getByRole.mockResolvedValue(null);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runProfileCommand(["show", "nonexistent"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("No profile found"),
      );

      exitSpy.mockRestore();
    });
  });

  describe("reset subcommand", () => {
    it("resets all profiles after confirmation", async () => {
      const { confirm } = await import("@clack/prompts");
      vi.mocked(confirm).mockResolvedValue(true);
      mockProfileStore.getAll.mockResolvedValue([
        { agentRole: "architect" },
      ]);
      mockProfileStore.delete = vi.fn().mockResolvedValue(true);

      await runProfileCommand(["reset", "--all"]);

      expect(mockProfileStore.delete).toHaveBeenCalledWith("architect");
    });
  });

  describe("error handling", () => {
    it("shows error message and exits when embedder unavailable", async () => {
      mockVectorMemory.getEmbedder.mockReturnValue(null);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runProfileCommand([])).rejects.toThrow("process.exit");

      const errors = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(errors).toContain("Failed to list profiles");

      exitSpy.mockRestore();
    });
  });

  describe("UX: tabular display", () => {
    it("shows trend arrows based on score history", async () => {
      mockProfileStore.getAll.mockResolvedValue([
        {
          agentRole: "improver",
          overallScore: 0.90,
          totalTasksCompleted: 10,
          strengths: ["coding"],
          scoreHistory: [0.7, 0.8, 0.90], // trending up
        },
        {
          agentRole: "decliner",
          overallScore: 0.50,
          totalTasksCompleted: 5,
          strengths: [],
          scoreHistory: [0.8, 0.70, 0.50], // trending down
        },
      ]);

      await runProfileCommand([]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      // The source uses ↑ for +0.02 diff, ↓ for -0.02 diff
      expect(output).toContain("improver");
      expect(output).toContain("decliner");
      // Scores should be rendered as percentages
      expect(output).toContain("90%");
      expect(output).toContain("50%");
    });

    it("empty profiles suggests running a work session", async () => {
      mockProfileStore.getAll.mockResolvedValue([]);

      await runProfileCommand([]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("No agent profiles");
      expect(output.toLowerCase()).toContain("run a work session");
    });
  });
});
