import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";

// Mock fetch globally
const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;

import {
  fetchOpenAICompatibleModels,
  fetchAnthropicModels,
  fetchGeminiModels,
  fetchOllamaModels,
  fetchModelsForProvider,
  formatModelName,
} from "../../src/providers/model-fetcher.js";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  } as Response;
}

describe("fetchOpenAICompatibleModels", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("filters out embedding models", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [
        { id: "gpt-5.4" },
        { id: "text-embedding-3-large" },
        { id: "text-embedding-ada-002" },
        { id: "gpt-5.4-mini" },
      ],
    }));

    const result = await fetchOpenAICompatibleModels("https://api.openai.com/v1", "sk-test");
    expect(result.source).toBe("live");
    expect(result.models.map((m) => m.id)).toEqual(
      expect.not.arrayContaining(["text-embedding-3-large", "text-embedding-ada-002"]),
    );
    expect(result.models.some((m) => m.id === "gpt-5.4")).toBe(true);
  });

  it("filters out image/tts/whisper models", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [
        { id: "gpt-5.4" },
        { id: "dall-e-3" },
        { id: "tts-1-hd" },
        { id: "whisper-1" },
        { id: "sora-2025" },
      ],
    }));

    const result = await fetchOpenAICompatibleModels("https://api.openai.com/v1", "sk-test");
    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe("gpt-5.4");
  });

  it("handles HTTP 401 gracefully", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await fetchOpenAICompatibleModels("https://api.openai.com/v1", "bad-key");
    expect(result.source).toBe("fallback");
    expect(result.error).toContain("401");
    expect(result.models).toHaveLength(0);
  });

  it("handles timeout gracefully", async () => {
    mockFetch.mockImplementationOnce(() =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("The operation was aborted")), 10),
      ),
    );

    const result = await fetchOpenAICompatibleModels(
      "https://api.openai.com/v1", "sk-test", { timeout: 5 },
    );
    expect(result.source).toBe("fallback");
    expect(result.error).toBeDefined();
    expect(result.models).toHaveLength(0);
  });

  it("uses x-api-key header when specified", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-1" }] }));

    await fetchOpenAICompatibleModels("https://api.example.com/v1", "test-key", {
      authHeader: "x-api-key",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "test-key" }),
      }),
    );
  });

  it("handles empty response data", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const result = await fetchOpenAICompatibleModels("https://api.openai.com/v1", "sk-test");
    expect(result.source).toBe("live");
    expect(result.models).toHaveLength(0);
  });
});

describe("fetchAnthropicModels", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("uses x-api-key header", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [
        { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
        { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
      ],
    }));

    const result = await fetchAnthropicModels("sk-ant-api03-test");
    expect(result.source).toBe("live");
    expect(result.models).toHaveLength(2);
    expect(result.models[0].name).toBe("Claude Opus 4.6");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "sk-ant-api03-test",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });

  it("handles API error", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 403));

    const result = await fetchAnthropicModels("bad-key");
    expect(result.source).toBe("fallback");
    expect(result.error).toContain("403");
  });
});

describe("fetchGeminiModels", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("filters to generateContent only", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      models: [
        { name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3-flash", displayName: "Gemini 3 Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
        { name: "models/text-bison", supportedGenerationMethods: ["generateText"] },
      ],
    }));

    const result = await fetchGeminiModels("AIzaTest");
    expect(result.source).toBe("live");
    expect(result.models).toHaveLength(2);
    expect(result.models.map((m) => m.id)).toEqual(["gemini-3-pro", "gemini-3-flash"]);
  });
});

describe("fetchOllamaModels", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("returns models from running Ollama", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      models: [
        { name: "llama3:latest", size: 4700000000 },
        { name: "mistral:latest", size: 3800000000 },
      ],
    }));

    const result = await fetchOllamaModels("http://localhost:11434");
    expect(result.source).toBe("live");
    expect(result.models).toHaveLength(2);
    expect(result.models[0].id).toBe("llama3:latest");
  });

  it("returns 'Ollama not running' on ECONNREFUSED", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

    const result = await fetchOllamaModels("http://localhost:11434");
    expect(result.source).toBe("fallback");
    expect(result.error).toBe("Ollama not running");
  });
});

describe("fetchModelsForProvider", () => {
  beforeEach(() => { mockFetch.mockReset(); });

  it("routes anthropic to anthropic fetcher", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ id: "claude-sonnet-4-6" }],
    }));

    const result = await fetchModelsForProvider("anthropic", "sk-ant-test");
    expect(result.source).toBe("live");
    // Verify it called the Anthropic endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.anything(),
    );
  });

  it("routes ollama to ollama fetcher", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      models: [{ name: "llama3" }],
    }));

    const result = await fetchModelsForProvider("ollama", "", "http://localhost:11434");
    expect(result.source).toBe("live");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything(),
    );
  });

  it("routes gemini to gemini fetcher", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      models: [{ name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent"] }],
    }));

    const result = await fetchModelsForProvider("gemini", "AIzaTest");
    expect(result.source).toBe("live");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com"),
      expect.anything(),
    );
  });

  it("returns fallback for bedrock", async () => {
    const result = await fetchModelsForProvider("bedrock", "");
    expect(result.source).toBe("fallback");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns fallback for vertex", async () => {
    const result = await fetchModelsForProvider("vertex", "");
    expect(result.source).toBe("fallback");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns fallback for azure", async () => {
    const result = await fetchModelsForProvider("azure", "");
    expect(result.source).toBe("fallback");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("routes openai to openai-compatible fetcher", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-5.4" }] }));

    const result = await fetchModelsForProvider("openai", "sk-test");
    expect(result.source).toBe("live");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.anything(),
    );
  });

  it("routes groq to openai-compatible fetcher with correct URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: "llama-3.3-70b" }] }));

    const result = await fetchModelsForProvider("groq", "gsk_test");
    expect(result.source).toBe("live");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      expect.anything(),
    );
  });
});

describe("formatModelName", () => {
  it("strips date suffixes", () => {
    expect(formatModelName("claude-3-opus-20240229")).toBe("Claude 3 Opus");
  });

  it("strips fireworks prefix", () => {
    expect(formatModelName("accounts/fireworks/models/llama-3-70b")).toBe("Llama 3 70b");
  });

  it("strips models/ prefix", () => {
    expect(formatModelName("models/gemini-3-pro")).toBe("Gemini 3 Pro");
  });

  it("capitalizes words", () => {
    expect(formatModelName("gpt-5.4-mini")).toBe("Gpt 5.4 Mini");
  });
});
