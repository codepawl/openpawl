import { describe, it, expect } from "bun:test";
import { PROVIDER_CATALOG, getProviderMeta, getAllProviderIds } from "../../src/providers/provider-catalog.js";

describe("provider-catalog", () => {
  it("exports a catalog with all expected provider IDs", () => {
    const ids = getAllProviderIds();
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("copilot");
    expect(ids).toContain("chatgpt");
    expect(ids).toContain("gemini");
    expect(ids).toContain("grok");
    expect(ids).toContain("mistral");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("groq");
    expect(ids).toContain("cerebras");
    expect(ids).toContain("together");
    expect(ids).toContain("fireworks");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("perplexity");
    expect(ids).toContain("moonshot");
    expect(ids).toContain("zai");
    expect(ids).toContain("minimax");
    expect(ids).toContain("cohere");
    expect(ids).toContain("opencode-zen");
    expect(ids).toContain("opencode-go");
    expect(ids).toContain("bedrock");
    expect(ids).toContain("vertex");
    expect(ids).toContain("azure");
    expect(ids).toContain("ollama");
    expect(ids).toContain("lmstudio");
    expect(ids).toContain("custom");
    expect(ids.length).toBeGreaterThanOrEqual(26);
  });

  it("getProviderMeta returns correct metadata", () => {
    const meta = getProviderMeta("grok");
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("xAI Grok");
    expect(meta!.authMethod).toBe("apikey");
    expect(meta!.envKeys).toContain("XAI_API_KEY");
    expect(meta!.models.length).toBeGreaterThan(0);
  });

  it("getProviderMeta returns undefined for unknown provider", () => {
    expect(getProviderMeta("nonexistent")).toBeUndefined();
  });

  it("each catalog entry has required fields", () => {
    for (const [id, meta] of Object.entries(PROVIDER_CATALOG)) {
      expect(meta.name, `${id} missing name`).toBeTruthy();
      expect(meta.authMethod, `${id} missing authMethod`).toBeTruthy();
      expect(meta.category, `${id} missing category`).toBeTruthy();
      expect(meta.models, `${id} missing models`).toBeDefined();
    }
  });
});
