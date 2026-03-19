import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { CopilotProvider } from "../../src/providers/copilot-provider.js";

describe("CopilotProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("constructs with github token and copilot token", () => {
    const provider = new CopilotProvider({
      githubToken: "ghu_test123",
      copilotToken: "tid=test;token=test123",
      copilotTokenExpiry: Date.now() + 30 * 60 * 1000,
      model: "claude-sonnet-4.6",
    });
    expect(provider.name).toBe("copilot");
    expect(provider.isAvailable()).toBe(true);
  });

  it("is unavailable without tokens", () => {
    const provider = new CopilotProvider({});
    expect(provider.isAvailable()).toBe(false);
  });

  it("health check returns false without tokens", async () => {
    const provider = new CopilotProvider({});
    expect(await provider.healthCheck()).toBe(false);
  });

  it("refreshes copilot token when expired", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: "new-copilot-token",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      }),
    });

    const provider = new CopilotProvider({
      githubToken: "ghu_test123",
      copilotToken: "old-token",
      copilotTokenExpiry: Date.now() - 1000,
      model: "claude-sonnet-4.6",
    });

    const result = await provider.healthCheck();
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/v2/token",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "token ghu_test123",
        }),
      }),
    );
  });

  it("picks up GITHUB_TOKEN from env", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghu_env_token");
    const provider = new CopilotProvider({});
    expect(provider.isAvailable()).toBe(true);
  });
});
