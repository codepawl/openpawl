import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock global-config before importing the module under test
const mockReadGlobalConfig = vi.fn();
const mockWriteGlobalConfig = vi.fn();
const mockBuildDefaultGlobalConfig = vi.fn(() => ({
  version: 1,
  managedGateway: true,
  gatewayHost: "127.0.0.1",
  gatewayPort: 18789,
  apiPort: 18791,
  gatewayUrl: "ws://127.0.0.1:18789",
  apiUrl: "http://127.0.0.1:18791",
  token: "",
  model: "",
  chatEndpoint: "/v1/chat/completions",
  dashboardPort: 9001,
  debugMode: false,
}));

vi.mock("../src/core/global-config.js", () => ({
  readGlobalConfig: mockReadGlobalConfig,
  writeGlobalConfig: mockWriteGlobalConfig,
  buildDefaultGlobalConfig: mockBuildDefaultGlobalConfig,
  readGlobalConfigWithDefaults: () =>
    mockReadGlobalConfig() ?? mockBuildDefaultGlobalConfig(),
  getGlobalConfigPath: () => "/tmp/.teamclaw/config.json",
  normalizeGlobalConfig: (input: Record<string, unknown>) => input,
}));

// Mock config.js to prevent filesystem side effects
vi.mock("../src/core/config.js", () => ({
  CONFIG: {
    openclawModel: "",
    openclawWorkerUrl: "",
    openclawHttpUrl: "",
    openclawToken: "",
    openclawChatEndpoint: "/v1/chat/completions",
  },
  setOpenClawModel: vi.fn(),
}));

// Mock discovery to avoid filesystem reads
vi.mock("../src/core/discovery.js", () => ({
  readLocalOpenClawConfig: () => null,
  discoverOpenAIApi: vi.fn(async () => []),
}));

// We need to import AFTER mocking
const {
  resolveAlias,
  isModelAllowed,
  resolveModelForAgent,
  setDefaultModel,
  setAgentModel,
  resetAgentModels,
  getModelConfig,
  clearModelConfigCache,
  setAlias,
  removeAlias,
  getAliases,
  setAllowlist,
  getAllowlist,
  setFallbackChain,
  getFallbackChain,
} = await import("../src/core/model-config.js");

describe("model-config: alias resolution", () => {
  beforeEach(() => {
    clearModelConfigCache();
    resetAgentModels();
    setAllowlist([]);
    setFallbackChain([]);
    mockReadGlobalConfig.mockReturnValue(null);
  });

  it("resolveAlias returns the model if no alias matches", () => {
    expect(resolveAlias("gpt-4o")).toBe("gpt-4o");
  });

  it("resolveAlias returns the target for a known alias", () => {
    setAlias("fast", "gpt-4o-mini");
    expect(resolveAlias("fast")).toBe("gpt-4o-mini");
  });

  it("setAlias / removeAlias / getAliases work", () => {
    setAlias("smart", "claude-opus");
    expect(getAliases()).toHaveProperty("smart", "claude-opus");

    removeAlias("smart");
    expect(getAliases()).not.toHaveProperty("smart");
  });
});

describe("model-config: allowlist enforcement", () => {
  beforeEach(() => {
    clearModelConfigCache();
    resetAgentModels();
    setAllowlist([]);
    setFallbackChain([]);
    mockReadGlobalConfig.mockReturnValue(null);
  });

  it("empty allowlist allows all models", () => {
    expect(isModelAllowed("anything")).toBe(true);
  });

  it("non-empty allowlist blocks unlisted models", () => {
    setAllowlist(["gpt-4o", "gpt-4o-mini"]);
    expect(isModelAllowed("gpt-4o")).toBe(true);
    expect(isModelAllowed("claude-opus")).toBe(false);
  });

  it("getAllowlist returns the current list", () => {
    setAllowlist(["a", "b"]);
    expect(getAllowlist()).toEqual(["a", "b"]);
  });

  it("resolveModelForAgent falls back when model is blocked by allowlist", () => {
    setDefaultModel("blocked-model");
    setAllowlist(["allowed-model"]);
    setFallbackChain(["allowed-model"]);

    const resolved = resolveModelForAgent("default");
    expect(resolved).toBe("allowed-model");
  });
});

describe("model-config: fallback chain", () => {
  beforeEach(() => {
    clearModelConfigCache();
    resetAgentModels();
    setAllowlist([]);
    setFallbackChain([]);
    mockReadGlobalConfig.mockReturnValue(null);
  });

  it("setFallbackChain / getFallbackChain work", () => {
    setFallbackChain(["model-a", "model-b"]);
    expect(getFallbackChain()).toEqual(["model-a", "model-b"]);
  });

  it("fallback chain from global config is used when no runtime override", () => {
    mockReadGlobalConfig.mockReturnValue({
      ...mockBuildDefaultGlobalConfig(),
      fallbackChain: ["global-fallback"],
    });
    // Reset to pick up config
    setFallbackChain([]);
    clearModelConfigCache();
    const chain = getFallbackChain();
    expect(chain).toEqual(["global-fallback"]);
  });
});

describe("model-config: getModelConfig includes new fields", () => {
  beforeEach(() => {
    clearModelConfigCache();
    resetAgentModels();
    setAllowlist([]);
    setFallbackChain([]);
    mockReadGlobalConfig.mockReturnValue(null);
  });

  it("includes aliases and allowlist in config snapshot", () => {
    setAlias("quick", "gpt-4o-mini");
    setAllowlist(["gpt-4o", "gpt-4o-mini"]);

    const config = getModelConfig();
    expect(config.aliases).toHaveProperty("quick", "gpt-4o-mini");
    expect(config.allowlist).toContain("gpt-4o");
    expect(config.allowlist).toContain("gpt-4o-mini");
  });
});
