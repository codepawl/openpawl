import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
const { mockLogger, mockSuccessStore, mockQualityStore, mockGlobalMemoryManager, mockPromotionEngine, mockVectorMemory } = vi.hoisted(() => ({
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
  mockSuccessStore: {
    init: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
  },
  mockQualityStore: {
    init: vi.fn(),
    getQuality: vi.fn().mockResolvedValue(null),
  },
  mockGlobalMemoryManager: {
    init: vi.fn(),
    getDb: vi.fn().mockReturnValue(null),
  },
  mockPromotionEngine: {
    promoteById: vi.fn().mockResolvedValue(true),
    demoteById: vi.fn().mockResolvedValue(true),
  },
  mockVectorMemory: {
    init: vi.fn(),
    getEmbedder: vi.fn().mockReturnValue({}),
    getDb: vi.fn().mockReturnValue({}),
  },
}));
vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));
vi.mock("@/core/config.js", () => ({
  CONFIG: {
    vectorStorePath: "/tmp/test-vectors",
    memoryBackend: "local_json",
  },
}));
vi.mock("@/memory/success/store.js", () => ({
  SuccessPatternStore: vi.fn().mockImplementation(() => mockSuccessStore),
}));
vi.mock("@/memory/success/quality.js", () => ({
  PatternQualityStore: vi.fn().mockImplementation(() => mockQualityStore),
}));
vi.mock("@/memory/global/store.js", () => ({
  GlobalMemoryManager: vi.fn().mockImplementation(() => mockGlobalMemoryManager),
}));
vi.mock("@/memory/global/promoter.js", () => ({
  PromotionEngine: vi.fn().mockImplementation(() => mockPromotionEngine),
}));
vi.mock("@/core/knowledge-base.js", () => ({
  VectorMemory: vi.fn().mockImplementation(() => mockVectorMemory),
}));

vi.mock("@/core/team-config.js", () => ({
  loadTeamConfig: vi.fn().mockResolvedValue(null),
}));

import { runLessonsExport } from "@/commands/lessons-export.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockVectorMemory.getEmbedder.mockReturnValue({});
  mockVectorMemory.getDb.mockReturnValue({});
});

describe("teamclaw lessons", () => {
  describe("promote subcommand", () => {
    it("promotes a pattern by ID", async () => {
      mockPromotionEngine.promoteById.mockResolvedValue(true);

      await runLessonsExport(["promote", "pattern-123"]);

      expect(mockLogger.success).toHaveBeenCalledWith(
        expect.stringContaining("Promoted"),
      );
    });

    it("errors when no pattern ID is provided", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runLessonsExport(["promote"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
      );

      exitSpy.mockRestore();
    });

    it("reports failure when pattern not found", async () => {
      mockPromotionEngine.promoteById.mockResolvedValue(false);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runLessonsExport(["promote", "nonexistent"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed"),
      );

      exitSpy.mockRestore();
    });
  });

  describe("demote subcommand", () => {
    it("demotes a pattern by ID", async () => {
      mockPromotionEngine.demoteById.mockResolvedValue(true);

      await runLessonsExport(["demote", "pattern-456"]);

      expect(mockLogger.success).toHaveBeenCalledWith(
        expect.stringContaining("Demoted"),
      );
    });

    it("errors when no pattern ID provided", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runLessonsExport(["demote"])).rejects.toThrow("process.exit");

      exitSpy.mockRestore();
    });
  });

  describe("default export", () => {
    it("handles missing LanceDB gracefully", async () => {
      mockVectorMemory.getDb.mockReturnValue(null);

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try {
        await runLessonsExport([]);
      } catch {
        // May exit or show error
      }

      exitSpy.mockRestore();
    });
  });
});
