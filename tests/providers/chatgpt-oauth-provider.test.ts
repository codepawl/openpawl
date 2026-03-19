import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    constructor(config: Record<string, unknown>) { this.apiKey = config.apiKey as string; }
    chat = {
      completions: {
        create: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: async function* () {
            yield { choices: [{ delta: { content: "ok" } }] };
            yield { choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        }),
      },
    };
    models = { list: vi.fn().mockResolvedValue({ data: [] }) };
  },
}));

vi.mock("../../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { ChatGPTOAuthProvider } from "../../src/providers/chatgpt-oauth-provider.js";

describe("ChatGPTOAuthProvider", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("constructs with OAuth tokens", () => {
    const provider = new ChatGPTOAuthProvider({
      oauthToken: "test-token",
      refreshToken: "test-refresh",
      tokenExpiry: Date.now() + 60 * 60 * 1000,
      model: "gpt-5.3-codex",
    });
    expect(provider.name).toBe("chatgpt");
    expect(provider.isAvailable()).toBe(true);
  });

  it("is unavailable without OAuth token", () => {
    const provider = new ChatGPTOAuthProvider({});
    expect(provider.isAvailable()).toBe(false);
  });

  it("health check returns false without token", async () => {
    const provider = new ChatGPTOAuthProvider({});
    expect(await provider.healthCheck()).toBe(false);
  });

  it("health check returns true with valid token", async () => {
    const provider = new ChatGPTOAuthProvider({ oauthToken: "test-token" });
    expect(await provider.healthCheck()).toBe(true);
  });

  it("streams completion with OAuth token", async () => {
    const provider = new ChatGPTOAuthProvider({ oauthToken: "test-token", model: "gpt-4o" });
    const chunks: string[] = [];
    for await (const chunk of provider.stream("Hello")) {
      chunks.push(chunk.content);
    }
    expect(chunks).toContain("ok");
  });
});
