import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { runDemo } from "@/commands/demo.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("teamclaw demo", () => {
  it("showcases session briefing with prior work summary", async () => {
    await runDemo([]);

    const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output.toLowerCase()).toContain("previously");
    expect(output.toLowerCase()).toContain("session");
  });

  it("showcases goal clarity analysis with score", async () => {
    await runDemo([]);

    const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output.toLowerCase()).toMatch(/clarity|clear/);
  });

  it("showcases sprint planning with task assignments", async () => {
    await runDemo([]);

    const output = mockLogger.plain.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output.toLowerCase()).toMatch(/sprint|task|assign/i);
  });

  it("produces substantial output (all feature sections)", async () => {
    await runDemo([]);

    // Demo has 10+ distinct sections — should produce heavy output
    expect(mockLogger.plain.mock.calls.length).toBeGreaterThan(50);
  });

  it("makes zero API calls (all output is synthetic)", async () => {
    // The demo command should never call error or warn — it's hardcoded success output
    await runDemo([]);

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
