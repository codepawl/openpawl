/**
 * Shared mock for @/core/logger.js.
 * Captures all output for assertion.
 */
import { vi } from "vitest";

export function createMockLogger() {
  return {
    plain: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    agent: vi.fn(),
    plainLine: vi.fn().mockReturnValue(""),
  };
}

/** Collect all plain() calls into a single string for searching. */
export function getPlainOutput(mockLogger: ReturnType<typeof createMockLogger>): string {
  return mockLogger.plain.mock.calls.map((c) => String(c[0])).join("\n");
}

/** Collect all error() calls into a single string. */
export function getErrorOutput(mockLogger: ReturnType<typeof createMockLogger>): string {
  return mockLogger.error.mock.calls.map((c) => String(c[0])).join("\n");
}
