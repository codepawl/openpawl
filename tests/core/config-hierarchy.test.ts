import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the JSON config layer so tests don't touch the filesystem
vi.mock("@/core/jsonConfigManager.js", () => ({
  readOpenpawlConfig: () => ({
    path: "/test/openpawl.config.json",
    data: { apikey: "sk-ant-test-1234567890", creativity: 0.7, goal: "Build something" },
  }),
  writeOpenpawlConfig: vi.fn(),
  getJsonKey: vi.fn((key: string, data: Record<string, unknown>) => data[key]),
  setJsonKey: vi.fn(),
}));

describe("configManager", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("isSecretKey", () => {
    it("identifies secret-like keys", async () => {
      const { isSecretKey } = await import("@/core/configManager.js");
      expect(isSecretKey("OPENAI_API_KEY")).toBe(true);
      expect(isSecretKey("ANTHROPIC_API_KEY")).toBe(true);
      expect(isSecretKey("DATABASE_SECRET")).toBe(true);
      expect(isSecretKey("GITHUB_TOKEN")).toBe(true);
    });

    it("returns false for non-secret keys", async () => {
      const { isSecretKey } = await import("@/core/configManager.js");
      expect(isSecretKey("creativity")).toBe(false);
      expect(isSecretKey("max_cycles")).toBe(false);
      expect(isSecretKey("goal")).toBe(false);
    });
  });

  describe("getConfigValue masking", () => {
    it("masks secret keys in non-raw mode", async () => {
      const { getConfigValue } = await import("@/core/configManager.js");
      const result = getConfigValue("apikey", { raw: false });
      expect(result.masked).toBe(true);
      // Should not return the full key
      expect(result.value).not.toBe("sk-ant-test-1234567890");
    });

    it("returns raw value when raw=true", async () => {
      const { getConfigValue } = await import("@/core/configManager.js");
      const result = getConfigValue("apikey", { raw: true });
      expect(result.value).toBe("sk-ant-test-1234567890");
    });
  });

  describe("setConfigValue validation", () => {
    it("accepts valid creativity value", async () => {
      const { setConfigValue } = await import("@/core/configManager.js");
      const result = setConfigValue("creativity", "0.8");
      expect("error" in result).toBe(false);
    });

    it("rejects creativity > 1", async () => {
      const { setConfigValue } = await import("@/core/configManager.js");
      const result = setConfigValue("creativity", "1.5") as { error: string };
      expect(result.error).toContain("creativity");
    });

    it("rejects non-numeric creativity", async () => {
      const { setConfigValue } = await import("@/core/configManager.js");
      const result = setConfigValue("creativity", "abc") as { error: string };
      expect(result.error).toContain("creativity");
    });

    it("accepts valid max_cycles", async () => {
      const { setConfigValue } = await import("@/core/configManager.js");
      const result = setConfigValue("max_cycles", "10");
      expect("error" in result).toBe(false);
    });

    it("rejects max_cycles < 1", async () => {
      const { setConfigValue } = await import("@/core/configManager.js");
      const result = setConfigValue("max_cycles", "0") as { error: string };
      expect(result.error).toContain("max_cycles");
    });

    it("passes through string values for template/goal", async () => {
      const { setConfigValue } = await import("@/core/configManager.js");
      const result = setConfigValue("goal", "Build an auth system");
      expect("error" in result).toBe(false);
    });
  });
});
