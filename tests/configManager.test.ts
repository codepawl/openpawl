import { describe, expect, test, vi } from "vitest";

vi.mock("../src/core/jsonConfigManager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/jsonConfigManager.js")>(
    "../src/core/jsonConfigManager.js",
  );
  return {
    ...actual,
    readTeamclawConfig: () => ({ 
      path: "/x/teamclaw.config.json", 
      data: { 
        creativity: 0.7, 
        max_cycles: 5,
        OPENAI_API_KEY: "sk-test-1234567890",
        FOO: "bar",
      } 
    }),
  };
});

import { getConfigValue } from "../src/core/configManager.js";

describe("configManager", () => {
  test("routes known JSON keys to teamclaw.config.json", () => {
    const res = getConfigValue("creativity");
    expect(res.source).toBe("teamclaw.config.json");
    expect(res.value).toBe("0.7");
  });

  test("routes other keys to teamclaw.config.json", () => {
    const res = getConfigValue("FOO");
    expect(res.source).toBe("teamclaw.config.json");
    expect(res.value).toBe("bar");
  });

  test("masks secret-like keys by default", () => {
    const res = getConfigValue("OPENAI_API_KEY");
    expect(res.source).toBe("teamclaw.config.json");
    expect(res.masked).toBe(true);
    expect(res.value).toMatch(/^sk-…\d{4}$/);
  });

  test("returns raw secrets when --raw is used", () => {
    const res = getConfigValue("OPENAI_API_KEY", { raw: true });
    expect(res.masked).toBe(false);
    expect(res.value).toBe("sk-test-1234567890");
  });

  test("returns null for unknown keys", () => {
    const res = getConfigValue("UNKNOWN_KEY");
    expect(res.value).toBeNull();
  });

  test("returns null for missing config", () => {
    const res = getConfigValue("NONEXISTENT");
    expect(res.value).toBeNull();
    expect(res.source).toBe("teamclaw.config.json");
  });
});

