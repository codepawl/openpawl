import { describe, expect, test, vi } from "vitest";

vi.mock("../src/core/envManager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/envManager.js")>("../src/core/envManager.js");
  return {
    ...actual,
    readEnvFile: () => ({ path: "/x/.env", lines: ["OPENAI_API_KEY=sk-test-1234567890", "FOO=bar"] }),
  };
});

vi.mock("../src/core/jsonConfigManager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/jsonConfigManager.js")>(
    "../src/core/jsonConfigManager.js",
  );
  return {
    ...actual,
    readTeamclawConfig: () => ({ path: "/x/teamclaw.config.json", data: { creativity: 0.7, max_cycles: 5 } }),
  };
});

import { getConfigValue } from "../src/core/configManager.js";

describe("configManager", () => {
  test("routes known JSON keys to teamclaw.config.json", () => {
    const res = getConfigValue("creativity");
    expect(res.source).toBe("teamclaw.config.json");
    expect(res.value).toBe("0.7");
  });

  test("routes other keys to .env", () => {
    const res = getConfigValue("FOO");
    expect(res.source).toBe(".env");
    expect(res.value).toBe("bar");
  });

  test("masks secret-like keys by default", () => {
    const res = getConfigValue("OPENAI_API_KEY");
    expect(res.source).toBe(".env");
    expect(res.masked).toBe(true);
    expect(res.value).toMatch(/^sk-…\d{4}$/);
  });

  test("returns raw secrets when --raw is used", () => {
    const res = getConfigValue("OPENAI_API_KEY", { raw: true });
    expect(res.masked).toBe(false);
    expect(res.value).toBe("sk-test-1234567890");
  });
});

