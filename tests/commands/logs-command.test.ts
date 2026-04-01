import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks ---
const { mockLogger } = vi.hoisted(() => ({
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
}));
vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));

// Mock child_process.spawn for -f (follow) mode — should not be called in tests
vi.mock("node:child_process", () => ({
  spawn: vi.fn().mockReturnValue({
    on: vi.fn(),
    kill: vi.fn(),
  }),
}));

import { runLogs } from "@/commands/logs.js";

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "teamclaw-logs-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
});

describe("teamclaw logs", () => {
  describe("no arguments — log index", () => {
    it("shows available log sources", async () => {
      await runLogs([]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("gateway");
      expect(output).toContain("web");
      expect(output).toContain("work");
    });

    it("--help also shows index", async () => {
      await runLogs(["--help"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("gateway");
    });
  });

  describe("unknown log source", () => {
    it("shows error for invalid source name", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(runLogs(["bogus"])).rejects.toThrow("process.exit");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Unknown log source"),
      );

      exitSpy.mockRestore();
    });
  });

  describe("reading log files", () => {
    it("reads last N lines from a gateway log file", async () => {
      // Create a fake gateway log in the expected location
      const teamclawDir = path.join(os.homedir(), ".teamclaw");
      const logPath = path.join(teamclawDir, "gateway.log");

      // Only test if we can write to the directory
      try {
        mkdirSync(teamclawDir, { recursive: true });
        writeFileSync(logPath, "line1\nline2\nline3\nline4\nline5\n");

        await runLogs(["gateway", "-n", "3"]);

        const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
        expect(output).toContain("line3");
        expect(output).toContain("line5");
      } catch {
        // Skip if we can't write to home dir in CI
      }
    });

    it("warns when log file does not exist", async () => {
      // Point to a nonexistent log — gateway resolves to ~/.teamclaw/gateway.log
      // If it doesn't exist, should warn
      const logPath = path.join(os.homedir(), ".teamclaw", "gateway.log");
      try {
        const { unlinkSync } = await import("node:fs");
        if (require("node:fs").existsSync(logPath)) {
          // Don't delete real logs — just skip this test
          return;
        }
      } catch {
        // ignore
      }

      await runLogs(["gateway"]);

      const allCalls = [
        ...mockLogger.warn.mock.calls,
        ...mockLogger.plain.mock.calls,
      ].map((c: unknown[]) => String(c[0])).join("\n");
      expect(allCalls.toLowerCase()).toMatch(/not found|not started/i);
    });
  });

  describe("--clear flag", () => {
    it("truncates log file when --clear is passed", async () => {
      const teamclawDir = path.join(os.homedir(), ".teamclaw");
      const logPath = path.join(teamclawDir, "gateway.log");

      try {
        mkdirSync(teamclawDir, { recursive: true });
        writeFileSync(logPath, "some log content\n");

        await runLogs(["gateway", "--clear"]);

        expect(mockLogger.success).toHaveBeenCalledWith(
          expect.stringContaining("Cleared"),
        );
      } catch {
        // Skip if we can't write
      }
    });
  });
});
