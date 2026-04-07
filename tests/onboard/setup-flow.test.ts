import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: "" })),
  select: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn(() => false),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), step: vi.fn() },
}));

vi.mock("../../src/providers/detect.js", () => ({
  detectProviders: vi.fn(),
}));
vi.mock("../../src/providers/validate.js", () => ({
  validateApiKey: vi.fn(),
}));
vi.mock("../../src/providers/model-fetcher.js", () => ({
  fetchModelsForProvider: vi.fn(),
}));
vi.mock("../../src/providers/model-cache.js", () => ({
  getCachedModels: vi.fn(() => Promise.resolve(null)),
  setCachedModels: vi.fn(),
}));
vi.mock("../../src/credentials/credential-store.js", () => ({
  CredentialStore: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({ isOk: () => true }),
    setCredential: vi.fn().mockResolvedValue({ isOk: () => true }),
  })),
}));
vi.mock("../../src/core/global-config.js", () => ({
  writeGlobalConfig: vi.fn(() => "/home/user/.openpawl/config.json"),
  readGlobalConfig: vi.fn(() => null),
  readGlobalConfigWithDefaults: vi.fn(() => ({ providers: [] })),
}));
vi.mock("../../src/utils/searchable-select.js", () => ({
  searchableSelect: vi.fn(),
}));

import { select, password } from "@clack/prompts";
import { detectProviders } from "../../src/providers/detect.js";
import { validateApiKey } from "../../src/providers/validate.js";
import { fetchModelsForProvider } from "../../src/providers/model-fetcher.js";
import { writeGlobalConfig } from "../../src/core/global-config.js";
import { ok } from "neverthrow";

describe("runSetup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes first-run flow: detect → select provider → key → model → save", async () => {
    vi.mocked(detectProviders).mockResolvedValue([
      { type: "anthropic", available: true, source: "env", envKey: "ANTHROPIC_API_KEY" },
      { type: "ollama", available: false, source: "ollama" },
    ]);
    vi.mocked(select)
      .mockResolvedValueOnce("anthropic")
      .mockResolvedValueOnce("claude-sonnet-4-6");
    vi.mocked(password).mockResolvedValue("sk-ant-api03-test-key");
    vi.mocked(validateApiKey).mockResolvedValue(ok({ latencyMs: 280 }));
    vi.mocked(fetchModelsForProvider).mockResolvedValue({
      models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
      source: "api",
    } as any);

    const { runSetup } = await import("../../src/onboard/setup-flow.js");
    await runSetup();

    expect(detectProviders).toHaveBeenCalled();
    expect(validateApiKey).toHaveBeenCalledWith("anthropic", "sk-ant-api03-test-key", expect.any(String));
    expect(fetchModelsForProvider).toHaveBeenCalledWith("anthropic", "sk-ant-api03-test-key", expect.any(String));
    expect(writeGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        activeProvider: "anthropic",
        activeModel: "claude-sonnet-4-6",
      }),
    );
  });

  it("pre-fills values during re-setup", async () => {
    vi.mocked(detectProviders).mockResolvedValue([
      { type: "anthropic", available: true, source: "env", envKey: "ANTHROPIC_API_KEY" },
    ]);
    vi.mocked(select)
      .mockResolvedValueOnce("anthropic")
      .mockResolvedValueOnce("claude-sonnet-4-6");
    vi.mocked(password).mockResolvedValue("sk-ant-existing-key");
    vi.mocked(validateApiKey).mockResolvedValue(ok({ latencyMs: 200 }));
    vi.mocked(fetchModelsForProvider).mockResolvedValue({
      models: ["claude-sonnet-4-6"],
      source: "api",
    } as any);

    const { runSetup } = await import("../../src/onboard/setup-flow.js");
    await runSetup({
      prefill: {
        version: 1,
        activeProvider: "anthropic",
        activeModel: "claude-sonnet-4-6",
        providers: [{ type: "anthropic", hasCredential: true }],
      } as any,
    });

    expect(writeGlobalConfig).toHaveBeenCalled();
  });
});
