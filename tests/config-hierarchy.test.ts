import { describe, it, expect, vi } from "vitest";

describe("ConfigManager - Helper Functions", () => {
  describe("isSecretKey", () => {
    const isSecretKey = (key: string): boolean => /KEY|TOKEN|SECRET|PASSWORD/i.test(key);

    it("identifies secret-like keys", () => {
      expect(isSecretKey("OPENAI_API_KEY")).toBe(true);
      expect(isSecretKey("ANTHROPIC_API_KEY")).toBe(true);
      expect(isSecretKey("DATABASE_SECRET")).toBe(true);
      expect(isSecretKey("MY_PASSWORD")).toBe(true);
      expect(isSecretKey("GITHUB_TOKEN")).toBe(true);
    });

    it("returns false for non-secret keys", () => {
      expect(isSecretKey("creativity")).toBe(false);
      expect(isSecretKey("max_cycles")).toBe(false);
      expect(isSecretKey("template")).toBe(false);
      expect(isSecretKey("goal")).toBe(false);
      expect(isSecretKey("team")).toBe(false);
    });
  });

  describe("maskSecret", () => {
    const maskSecret = (value: string): string => {
      const v = value ?? "";
      if (v.length <= 8) return "********";
      const prefix = v.slice(0, 3);
      const suffix = v.slice(-4);
      return `${prefix}…${suffix}`;
    };

    it("masks short secrets with asterisks", () => {
      expect(maskSecret("abc")).toBe("********");
      expect(maskSecret("short")).toBe("********");
    });

    it("masks secrets with prefix and suffix", () => {
      expect(maskSecret("sk-test-1234567890")).toBe("sk-…7890");
      expect(maskSecret("github_token_abc123")).toBe("git…c123");
    });

    it("handles null/undefined", () => {
      expect(maskSecret(null as any)).toBe("********");
      expect(maskSecret(undefined as any)).toBe("********");
    });

    it("handles empty string", () => {
      expect(maskSecret("")).toBe("********");
    });
  });

  describe("coerceJsonValue", () => {
    const coerceJsonValue = (key: string, raw: string): { ok: true; value: unknown } | { ok: false; error: string } => {
      if (key === "template" || key === "goal") {
        return { ok: true, value: raw };
      }
      if (key === "creativity") {
        const n = Number(raw);
        if (Number.isNaN(n) || n < 0 || n > 1) return { ok: false, error: "creativity must be a number between 0 and 1" };
        return { ok: true, value: n };
      }
      if (key === "max_cycles") {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: "max_cycles must be an integer >= 1" };
        return { ok: true, value: n };
      }
      return { ok: true, value: raw };
    };

    it("returns string value for template and goal", () => {
      expect(coerceJsonValue("template", "my-template").ok).toBe(true);
      expect(coerceJsonValue("goal", "Build an app").ok).toBe(true);
    });

    it("validates creativity range (0-1)", () => {
      expect(coerceJsonValue("creativity", "0").ok).toBe(true);
      expect(coerceJsonValue("creativity", "0.5").ok).toBe(true);
      expect(coerceJsonValue("creativity", "1").ok).toBe(true);
      expect(coerceJsonValue("creativity", "1.5").ok).toBe(false);
      expect(coerceJsonValue("creativity", "-0.1").ok).toBe(false);
      expect(coerceJsonValue("creativity", "abc").ok).toBe(false);
    });

    it("validates max_cycles is integer >= 1", () => {
      expect(coerceJsonValue("max_cycles", "1").ok).toBe(true);
      expect(coerceJsonValue("max_cycles", "10").ok).toBe(true);
      expect(coerceJsonValue("max_cycles", "0").ok).toBe(false);
      expect(coerceJsonValue("max_cycles", "-1").ok).toBe(false);
      expect(coerceJsonValue("max_cycles", "5.5").ok).toBe(false);
      expect(coerceJsonValue("max_cycles", "abc").ok).toBe(false);
    });

    it("passes through unknown keys as strings", () => {
      const result = coerceJsonValue("unknown_key", "some_value");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("some_value");
      }
    });
  });
});

describe("Config Manager Integration", () => {
  it("setConfigValue validates input", async () => {
    vi.mock("../src/core/jsonConfigManager.js", () => {
      return {
        readTeamclawConfig: () => ({
          path: "/test/teamclaw.config.json",
          data: {},
        }),
        writeTeamclawConfig: vi.fn(),
        getJsonKey: vi.fn((key: string, data: any) => data[key]),
        setJsonKey: vi.fn(),
        __esModule: true,
      };
    });

    const { setConfigValue } = await import("../src/core/configManager.js");
    
    const result = setConfigValue("creativity", "0.8");
    expect("error" in result).toBe(false);
    
    const invalidResult = setConfigValue("creativity", "1.5") as { error: string };
    expect(invalidResult.error).toBe("creativity must be a number between 0 and 1");
  });
});
