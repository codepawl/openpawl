import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamChunk } from "@/providers/stream-types.js";
import type { StreamProvider } from "@/providers/provider.js";

/* ------------------------------------------------------------------ */
/*  Shared mocks                                                      */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    plain: vi.fn(),
    success: vi.fn(),
  };
  const mockReadGlobalConfig = vi.fn().mockReturnValue(null);
  const mockReadGlobalConfigWithDefaults = vi.fn().mockReturnValue({
    version: 1,
    dashboardPort: 9001,
    debugMode: false,
    model: "",
    tokenOptimization: { modelRouting: { enabled: true } },
  });
  const mockBuildDefaultGlobalConfig = vi.fn().mockReturnValue({
    version: 1,
    dashboardPort: 9001,
    debugMode: false,
    model: "",
    tokenOptimization: { modelRouting: { enabled: true } },
  });
  const mockRecordTierDowngrade = vi.fn();

  return {
    mockLogger,
    mockReadGlobalConfig,
    mockReadGlobalConfigWithDefaults,
    mockBuildDefaultGlobalConfig,
    mockRecordTierDowngrade,
  };
});

vi.mock("@/core/logger.js", () => ({
  logger: mocks.mockLogger,
}));

vi.mock("@/core/global-config.js", () => ({
  readGlobalConfig: mocks.mockReadGlobalConfig,
  readGlobalConfigWithDefaults: mocks.mockReadGlobalConfigWithDefaults,
  buildDefaultGlobalConfig: mocks.mockBuildDefaultGlobalConfig,
}));

vi.mock("@/token-opt/stats.js", () => ({
  recordTierDowngrade: mocks.mockRecordTierDowngrade,
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeProvider(name: string, overrides: Partial<StreamProvider> = {}): StreamProvider {
  return {
    name,
    stream: overrides.stream ?? (async function* () {
      yield { content: `from-${name}`, done: false };
      yield { content: "", done: true };
    }),
    healthCheck: overrides.healthCheck ?? (async () => true),
    isAvailable: overrides.isAvailable ?? (() => true),
    setAvailable: overrides.setAvailable ?? (() => {}),
  };
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of gen) result.push(chunk);
  return result;
}

/* ------------------------------------------------------------------ */
/*  ProviderManager model-based ordering                              */
/* ------------------------------------------------------------------ */

describe("ProviderManager model-based ordering", () => {
  // Use dynamic import to avoid hoisting issues with mocks
  async function createManager(providers: StreamProvider[]) {
    const { ProviderManager } = await import("@/providers/provider-manager.js");
    return new ProviderManager(providers);
  }

  it("reorders chain to put anthropic first when model starts with claude-", async () => {
    const mgr = await createManager([makeProvider("openai"), makeProvider("anthropic")]);
    const chunks = await collectChunks(mgr.stream("test", { model: "claude-sonnet-4-6" }));
    expect(chunks[0]!.content).toBe("from-anthropic");
  });

  it("reorders chain to put openai first when model starts with gpt-", async () => {
    const mgr = await createManager([makeProvider("anthropic"), makeProvider("openai")]);
    const chunks = await collectChunks(mgr.stream("test", { model: "gpt-4o" }));
    expect(chunks[0]!.content).toBe("from-openai");
  });

  it("keeps original order when model has no known prefix", async () => {
    const mgr = await createManager([makeProvider("anthropic"), makeProvider("openai")]);
    const chunks = await collectChunks(mgr.stream("test", { model: "custom-model-v1" }));
    expect(chunks[0]!.content).toBe("from-anthropic");
  });

  it("keeps original order when no model specified", async () => {
    const mgr = await createManager([makeProvider("anthropic"), makeProvider("openai")]);
    const chunks = await collectChunks(mgr.stream("test"));
    expect(chunks[0]!.content).toBe("from-anthropic");
  });

  it("routes deepseek- models to deepseek provider", async () => {
    const mgr = await createManager([makeProvider("anthropic"), makeProvider("deepseek")]);
    const chunks = await collectChunks(mgr.stream("test", { model: "deepseek-coder" }));
    expect(chunks[0]!.content).toBe("from-deepseek");
  });

  it("routes copilot provider for gpt- models alongside openai", async () => {
    const mgr = await createManager([makeProvider("anthropic"), makeProvider("copilot")]);
    const chunks = await collectChunks(mgr.stream("test", { model: "gpt-4o" }));
    expect(chunks[0]!.content).toBe("from-copilot");
  });
});

/* ------------------------------------------------------------------ */
/*  resolveModelForAgent                                              */
/* ------------------------------------------------------------------ */

describe("resolveModelForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state between tests
    mocks.mockReadGlobalConfig.mockReturnValue(null);
  });

  async function getResolver() {
    // Dynamic import so each test gets fresh module state after resetModules
    const mod = await import("@/core/model-config.js");
    return mod;
  }

  it("returns tier default for utility agents (tester -> haiku)", async () => {
    const mod = await getResolver();
    // Set active provider family to anthropic so tier defaults use claude models
    mod.setActiveProviderFamily("anthropic");
    mod.resetAgentModels();
    mod.setConfigAgentModels({});
    mocks.mockReadGlobalConfig.mockReturnValue({
      version: 1,
      dashboardPort: 9001,
      debugMode: false,
      model: "",
      tokenOptimization: { modelRouting: { enabled: true } },
    });

    const result = mod.resolveModelForAgent("tester");
    expect(result).toBe("claude-haiku-4-5");
  });

  it("uses per-agent config override from teamclaw.config.json", async () => {
    const mod = await getResolver();
    mod.resetAgentModels();
    mod.setConfigAgentModels({ programmer: "claude-opus-4-6" });

    const result = mod.resolveModelForAgent("programmer");
    expect(result).toBe("claude-opus-4-6");
  });

  it("falls back through tier defaults when no config", async () => {
    const mod = await getResolver();
    mod.setActiveProviderFamily("openai");
    mod.resetAgentModels();
    mod.setConfigAgentModels({});
    mocks.mockReadGlobalConfig.mockReturnValue({
      version: 1,
      dashboardPort: 9001,
      debugMode: false,
      model: "",
      tokenOptimization: { modelRouting: { enabled: true } },
    });

    const result = mod.resolveModelForAgent("tester");
    expect(result).toBe("gpt-4o-mini");
  });

  it("normalizes role names (programmer-1 -> programmer)", async () => {
    const mod = await getResolver();
    mod.resetAgentModels();
    mod.setConfigAgentModels({ programmer: "claude-opus-4-6" });

    const result = mod.resolveModelForAgent("programmer-1");
    expect(result).toBe("claude-opus-4-6");
  });
});
