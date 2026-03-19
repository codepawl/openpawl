import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("ya29.mock-access-token\n"),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { VertexProvider } from "../../src/providers/vertex-provider.js";
import { ProviderError } from "../../src/providers/types.js";

describe("VertexProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("constructs with explicit config", () => {
    const provider = new VertexProvider({
      projectId: "my-project",
      region: "us-central1",
      model: "gemini-3-pro",
    });
    expect(provider.name).toBe("vertex");
    expect(provider.isAvailable()).toBe(true);
  });

  it("constructs from env vars", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "env-project");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/path/to/sa.json");
    const provider = new VertexProvider({});
    expect(provider.isAvailable()).toBe(true);
  });

  it("is unavailable without projectId", () => {
    const provider = new VertexProvider({});
    expect(provider.isAvailable()).toBe(false);
  });

  it("setAvailable toggles availability", () => {
    const provider = new VertexProvider({ projectId: "my-project" });
    expect(provider.isAvailable()).toBe(true);
    provider.setAvailable(false);
    expect(provider.isAvailable()).toBe(false);
  });

  it("health check returns false without projectId", async () => {
    const provider = new VertexProvider({});
    expect(await provider.healthCheck()).toBe(false);
  });

  it("health check returns true with valid token", async () => {
    const provider = new VertexProvider({ projectId: "my-project" });
    expect(await provider.healthCheck()).toBe(true);
  });

  it("streams vertex response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { candidates: [{ content: { parts: [{ text: "Hello from Vertex" }] } }] },
        { candidates: [{ content: { parts: [{ text: " AI" }] } }] },
      ],
    });

    const provider = new VertexProvider({ projectId: "my-project" });
    const chunks: string[] = [];
    for await (const chunk of provider.stream("Hello")) {
      chunks.push(chunk.content);
    }
    expect(chunks).toContain("Hello from Vertex");
    expect(chunks).toContain(" AI");
  });

  it("throws ProviderError on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });

    const provider = new VertexProvider({ projectId: "my-project" });
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of provider.stream("Hello")) {
        // consume
      }
    }).rejects.toThrow(ProviderError);
  });

  it("passes system prompt and temperature", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { candidates: [{ content: { parts: [{ text: "response" }] } }] },
      ],
    });

    const provider = new VertexProvider({ projectId: "my-project" });
    const chunks: string[] = [];
    for await (const chunk of provider.stream("Hello", {
      systemPrompt: "You are helpful",
      temperature: 0.5,
    })) {
      chunks.push(chunk.content);
    }

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("streamGenerateContent"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("systemInstruction"),
      }),
    );
  });
});
