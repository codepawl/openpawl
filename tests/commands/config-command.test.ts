/**
 * Config command tests.
 *
 * The interactive dashboard (runConfigDashboard, 737 LOC) is heavily
 * coupled to @clack/prompts loops. This file tests the non-interactive
 * config get/set/unset logic via configManager.ts, which is what the
 * CLI dispatches to for `teamclaw config get|set|unset`.
 *
 * Refactoring needed for full dashboard testability:
 * - Extract loadDashboardState() into a testable pure function
 * - Separate prompt logic from business logic in the dashboard loop
 * - Make the select-based menu testable by extracting action handlers
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---
const { mockJsonConfigManager } = vi.hoisted(() => ({
  mockJsonConfigManager: {
    readTeamclawConfig: vi.fn().mockReturnValue({ data: {}, path: "/tmp/test/teamclaw.config.json" }),
    writeTeamclawConfig: vi.fn(),
    getJsonKey: vi.fn(),
    setJsonKey: vi.fn(),
    unsetJsonKey: vi.fn(),
  },
}));
vi.mock("@/core/jsonConfigManager.js", () => mockJsonConfigManager);

import { getConfigValue, isSecretKey } from "@/core/configManager.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("configManager", () => {
  describe("getConfigValue", () => {
    it("reads a key from teamclaw.config.json", () => {
      mockJsonConfigManager.readTeamclawConfig.mockReturnValue({
        data: { creativity: 0.7 },
        path: "/tmp/test/teamclaw.config.json",
      });
      mockJsonConfigManager.getJsonKey.mockReturnValue(0.7);

      const result = getConfigValue("creativity", { cwd: "/tmp/test" });

      expect(result.value).toBe("0.7");
      expect(result.source).toBe("teamclaw.config.json");
    });

    it("returns null for missing key", () => {
      mockJsonConfigManager.readTeamclawConfig.mockReturnValue({
        data: {},
        path: "/tmp/test/teamclaw.config.json",
      });
      mockJsonConfigManager.getJsonKey.mockReturnValue(undefined);

      const result = getConfigValue("nonexistent", { cwd: "/tmp/test" });

      expect(result.value).toBeNull();
    });

    it("masks secret keys by default", () => {
      mockJsonConfigManager.readTeamclawConfig.mockReturnValue({
        data: { ANTHROPIC_API_KEY: "sk-ant-api03-very-long-key-here" },
        path: "/tmp/test/teamclaw.config.json",
      });
      mockJsonConfigManager.getJsonKey.mockReturnValue("sk-ant-api03-very-long-key-here");

      const result = getConfigValue("ANTHROPIC_API_KEY", { cwd: "/tmp/test" });

      expect(result.masked).toBe(true);
      expect(result.value).not.toBe("sk-ant-api03-very-long-key-here");
      expect(result.value).toContain("…"); // Masked format
    });

    it("returns raw secret value with raw option", () => {
      mockJsonConfigManager.readTeamclawConfig.mockReturnValue({
        data: { API_KEY: "sk-secret-123" },
        path: "/tmp/test/teamclaw.config.json",
      });
      mockJsonConfigManager.getJsonKey.mockReturnValue("sk-secret-123");

      const result = getConfigValue("API_KEY", { raw: true, cwd: "/tmp/test" });

      expect(result.masked).toBe(false);
      expect(result.value).toBe("sk-secret-123");
    });
  });

  describe("isSecretKey", () => {
    it("identifies API key patterns", () => {
      expect(isSecretKey("ANTHROPIC_API_KEY")).toBe(true);
      expect(isSecretKey("OPENAI_API_KEY")).toBe(true);
      expect(isSecretKey("webhookSecret")).toBe(true);
      expect(isSecretKey("API_TOKEN")).toBe(true);
    });

    it("does not flag non-secret keys", () => {
      expect(isSecretKey("creativity")).toBe(false);
      expect(isSecretKey("dashboardPort")).toBe(false);
      expect(isSecretKey("template")).toBe(false);
      expect(isSecretKey("memoryBackend")).toBe(false);
    });
  });
});
