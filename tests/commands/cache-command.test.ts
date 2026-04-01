import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
const { mockLogger, mockCacheStore, mockGlobalConfig } = vi.hoisted(() => ({
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
  mockCacheStore: {
    stats: vi.fn(),
    clear: vi.fn(),
    prune: vi.fn(),
  },
  mockGlobalConfig: {
    readGlobalConfigWithDefaults: vi.fn().mockReturnValue({ cacheEnabled: true }),
    writeGlobalConfig: vi.fn(),
  },
}));
vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));
vi.mock("@/cache/cache-store.js", () => ({
  ResponseCacheStore: vi.fn().mockImplementation(() => mockCacheStore),
}));
vi.mock("@/core/global-config.js", () => mockGlobalConfig);

import { runCacheCommand } from "@/commands/cache.js";

// --- Tests ---
beforeEach(() => {
  vi.clearAllMocks();
});

describe("teamclaw cache", () => {
  describe("argument parsing", () => {
    it("--help prints usage without touching cache store", async () => {
      await runCacheCommand(["--help"]);

      expect(mockLogger.plain).toHaveBeenCalled();
      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("cache");
      expect(output).toContain("stats");
      expect(output).toContain("clear");
      expect(mockCacheStore.stats).not.toHaveBeenCalled();
    });

    it("-h also prints usage with all subcommands listed", async () => {
      await runCacheCommand(["-h"]);
      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("stats");
      expect(output).toContain("clear");
      expect(output).toContain("prune");
      expect(output).toContain("disable");
      expect(output).toContain("enable");
    });

    it("no args prints same usage as --help", async () => {
      await runCacheCommand([]);
      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("Usage:");
      expect(output).toContain("stats");
    });

    it("unknown subcommand shows error and exits", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runCacheCommand(["bogus"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Unknown cache subcommand"),
      );

      exitSpy.mockRestore();
    });
  });

  describe("stats subcommand", () => {
    it("displays cache statistics from store", async () => {
      mockCacheStore.stats.mockResolvedValue({
        totalEntries: 42,
        hitRate: 0.75,
        totalHits: 120,
        totalSavedMs: 65000,
        totalSavingsUSD: 3.5,
        oldestEntry: Date.now() - 86400000,
      });

      await runCacheCommand(["stats"]);

      expect(mockCacheStore.stats).toHaveBeenCalledTimes(1);
      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("42");
      expect(output).toContain("75%");
      expect(output).toContain("120");
      expect(output).toContain("$3.50");
    });

    it("shows 0% hit rate when cache is empty", async () => {
      mockCacheStore.stats.mockResolvedValue({
        totalEntries: 0,
        hitRate: 0,
        totalHits: 0,
        totalSavedMs: 0,
        totalSavingsUSD: 0,
        oldestEntry: 0,
      });

      await runCacheCommand(["stats"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("0%");
      expect(output).toContain("0");
    });
  });

  describe("clear subcommand", () => {
    it("calls store.clear() and confirms", async () => {
      mockCacheStore.clear.mockResolvedValue(undefined);

      await runCacheCommand(["clear"]);

      expect(mockCacheStore.clear).toHaveBeenCalledTimes(1);
      expect(mockLogger.success).toHaveBeenCalledWith(
        expect.stringContaining("cleared"),
      );
    });
  });

  describe("prune subcommand", () => {
    it("reports number of pruned entries when > 0", async () => {
      mockCacheStore.prune.mockResolvedValue(5);

      await runCacheCommand(["prune"]);

      expect(mockCacheStore.prune).toHaveBeenCalledTimes(1);
      expect(mockLogger.success).toHaveBeenCalledWith(
        expect.stringContaining("5"),
      );
    });

    it("reports no expired entries when prune returns 0", async () => {
      mockCacheStore.prune.mockResolvedValue(0);

      await runCacheCommand(["prune"]);

      expect(mockLogger.plain).toHaveBeenCalledWith(
        expect.stringContaining("No expired entries"),
      );
    });
  });

  describe("enable/disable subcommands", () => {
    it("disable sets cacheEnabled=false on the config object before writing", async () => {
      const cfg = { cacheEnabled: true, otherSetting: "preserved" } as Record<string, unknown>;
      mockGlobalConfig.readGlobalConfigWithDefaults.mockReturnValue(cfg);

      await runCacheCommand(["disable"]);

      expect(cfg.cacheEnabled).toBe(false);
      expect(cfg.otherSetting).toBe("preserved"); // doesn't clobber other settings
      expect(mockGlobalConfig.writeGlobalConfig).toHaveBeenCalledWith(cfg);
      expect(mockLogger.success).toHaveBeenCalledWith("Response caching disabled.");
    });

    it("enable sets cacheEnabled=true on the config object before writing", async () => {
      const cfg = { cacheEnabled: false, otherSetting: "preserved" } as Record<string, unknown>;
      mockGlobalConfig.readGlobalConfigWithDefaults.mockReturnValue(cfg);

      await runCacheCommand(["enable"]);

      expect(cfg.cacheEnabled).toBe(true);
      expect(cfg.otherSetting).toBe("preserved");
      expect(mockGlobalConfig.writeGlobalConfig).toHaveBeenCalledWith(cfg);
      expect(mockLogger.success).toHaveBeenCalledWith("Response caching enabled.");
    });
  });

  describe("UX: output formatting", () => {
    it("stats displays time saved in human-readable format (minutes, not raw ms)", async () => {
      mockCacheStore.stats.mockResolvedValue({
        totalEntries: 10,
        hitRate: 0.5,
        totalHits: 5,
        totalSavedMs: 125000, // 2m 5s
        totalSavingsUSD: 1.0,
        oldestEntry: Date.now() - 3600000,
      });

      await runCacheCommand(["stats"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toMatch(/2m\s*5s/);
      expect(output).not.toContain("125000");
    });

    it("stats displays cost as dollars with 2 decimal places", async () => {
      mockCacheStore.stats.mockResolvedValue({
        totalEntries: 1,
        hitRate: 1,
        totalHits: 1,
        totalSavedMs: 100,
        totalSavingsUSD: 0.1,
        oldestEntry: Date.now(),
      });

      await runCacheCommand(["stats"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("$0.10");
    });

    it("unknown subcommand error includes help hint", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      try { await runCacheCommand(["foo"]); } catch { /* expected */ }

      const errors = mockLogger.error.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(errors).toContain("teamclaw cache --help");

      exitSpy.mockRestore();
    });
  });
});
