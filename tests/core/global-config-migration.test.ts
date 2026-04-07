import { describe, it, expect } from "vitest";
import { normalizeGlobalConfig } from "../../src/core/global-config.js";

describe("global config schema extensions", () => {
  it("preserves activeProvider and activeModel fields", () => {
    const config = normalizeGlobalConfig({
      version: 1,
      activeProvider: "anthropic",
      activeModel: "claude-sonnet-4-6",
      providers: [],
    });
    expect(config.activeProvider).toBe("anthropic");
    expect(config.activeModel).toBe("claude-sonnet-4-6");
  });

  it("defaults activeProvider to first provider type", () => {
    const config = normalizeGlobalConfig({
      version: 1,
      providers: [{ type: "openai", apiKey: "sk-test" }],
    });
    expect(config.activeProvider).toBe("openai");
  });

  it("defaults activeModel to model field", () => {
    const config = normalizeGlobalConfig({
      version: 1,
      model: "gpt-4o",
      providers: [],
    });
    expect(config.activeModel).toBe("gpt-4o");
  });

  it("preserves hasCredential flag on provider entries", () => {
    const config = normalizeGlobalConfig({
      version: 1,
      providers: [{ type: "anthropic", hasCredential: true }],
    });
    expect(config.providers![0].hasCredential).toBe(true);
    expect(config.providers![0].apiKey).toBeUndefined();
  });
});
