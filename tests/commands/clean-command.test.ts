import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn().mockResolvedValue(false),
  isCancel: vi.fn().mockReturnValue(false),
}));

import { runClean } from "@/commands/clean.js";

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "teamclaw-clean-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
});

describe("teamclaw clean", () => {
  describe("session data cleanup", () => {
    it("removes dist/ and data/vector_store/ when they exist", async () => {
      // Create test directories
      mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
      mkdirSync(path.join(tmpDir, "data", "vector_store"), { recursive: true });
      writeFileSync(path.join(tmpDir, "dist", "test.js"), "content");

      await runClean([]);

      expect(existsSync(path.join(tmpDir, "dist"))).toBe(false);
      expect(existsSync(path.join(tmpDir, "data", "vector_store"))).toBe(false);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("Removed dist/");
    });

    it("reports when no session data to clean", async () => {
      await runClean([]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("No session data");
    });
  });

  describe("--keep-cache flag", () => {
    it("preserves response cache when --keep-cache is passed", async () => {
      await runClean(["--keep-cache"]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("cache preserved");
    });
  });

  describe("--include-global flag", () => {
    it("does not remove global memory without --include-global", async () => {
      await runClean([]);

      const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(output).toContain("Global memory preserved");
    });
  });
});
