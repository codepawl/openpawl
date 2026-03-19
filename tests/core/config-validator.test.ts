import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

import { validateConfig, TeamClawConfigSchema } from "../../src/core/config-validator.js";

describe("validateConfig", () => {
  it("accepts valid minimal config", () => {
    const result = validateConfig({ version: 1, dashboardPort: 9001, debugMode: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dashboardPort).toBe(9001);
    }
  });

  it("accepts full config with all optional fields", () => {
    const result = validateConfig({
      version: 1,
      dashboardPort: 9001,
      debugMode: true,
      providers: [
        { type: "anthropic", apiKey: "sk-ant-test" },
        { type: "openai", apiKey: "sk-test" },
      ],
      agentModels: { coordinator: "claude-sonnet-4-6" },
      fallbackChain: ["anthropic", "openai"],
      confidenceScoring: { enabled: true, thresholds: { autoApprove: 0.85 } },
      handoff: { autoGenerate: true },
      personality: { enabled: true },
      workspaceDir: "./workspace",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providers).toHaveLength(2);
    }
  });

  it("applies default values correctly", () => {
    const result = validateConfig({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dashboardPort).toBe(9001);
      expect(result.data.debugMode).toBe(false);
    }
  });

  it("rejects config with invalid dashboardPort type", () => {
    const result = validateConfig({ dashboardPort: "not-a-number" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some(e => e.includes("dashboardPort"))).toBe(true);
    }
  });

  it("allows extra fields via passthrough", () => {
    const result = validateConfig({
      version: 1,
      dashboardPort: 9001,
      debugMode: false,
      someNewField: "future feature",
    });
    expect(result.success).toBe(true);
  });

  it("validates provider entry structure", () => {
    const result = validateConfig({
      providers: [{ type: "anthropic" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects provider with invalid authMethod", () => {
    const result = validateConfig({
      providers: [{ type: "anthropic", authMethod: "invalid-method" }],
    });
    expect(result.success).toBe(false);
  });
});
