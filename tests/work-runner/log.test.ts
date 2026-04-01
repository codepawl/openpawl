/**
 * Tests for work-runner/log.ts — session logging and console redirect.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLogger, mockAppendFile } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    plain: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    agent: vi.fn(),
    plainLine: vi.fn().mockReturnValue("FORMATTED LINE"),
  },
  mockAppendFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/core/logger.js", () => ({ logger: mockLogger }));
vi.mock("node:fs/promises", () => ({ appendFile: mockAppendFile }));

import { log, withConsoleRedirect, initLogPaths, getDebugLogPath, getWorkHistoryLogPath } from "@/work-runner/log.js";

beforeEach(() => {
  vi.clearAllMocks();
  initLogPaths("", ""); // reset paths
});

describe("log()", () => {
  it("routes info messages to logger.info", () => {
    log("info", "test message");
    expect(mockLogger.info).toHaveBeenCalledWith("test message");
  });

  it("routes warn messages to logger.warn", () => {
    log("warn", "warning");
    expect(mockLogger.warn).toHaveBeenCalledWith("warning");
  });

  it("routes error messages to logger.error", () => {
    log("error", "error");
    expect(mockLogger.error).toHaveBeenCalledWith("error");
  });

  it("appends to work history log when path is set", () => {
    initLogPaths("/tmp/debug.log", "/tmp/history.log");
    log("info", "logged");
    expect(mockAppendFile).toHaveBeenCalledWith(
      "/tmp/history.log",
      expect.stringContaining("FORMATTED LINE"),
    );
  });

  it("does not append when no log path is set", () => {
    initLogPaths("", "");
    log("info", "not logged");
    expect(mockAppendFile).not.toHaveBeenCalled();
  });
});

describe("initLogPaths / getters", () => {
  it("sets and gets debug log path", () => {
    initLogPaths("/tmp/session.log", "/tmp/history.log");
    expect(getDebugLogPath()).toBe("/tmp/session.log");
    expect(getWorkHistoryLogPath()).toBe("/tmp/history.log");
  });
});

describe("withConsoleRedirect()", () => {
  it("captures console.log output and restores originals", async () => {
    const originalLog = console.log;
    initLogPaths("/tmp/debug.log", "");

    const result = await withConsoleRedirect(async () => {
      console.log("captured output");
      return 42;
    });

    expect(result).toBe(42);
    expect(console.log).toBe(originalLog); // restored
    expect(mockAppendFile).toHaveBeenCalled();
  });

  it("restores console methods even if fn throws", async () => {
    const originalLog = console.log;

    await expect(withConsoleRedirect(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(console.log).toBe(originalLog); // still restored
  });
});
