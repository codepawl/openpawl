/**
 * Dynamic model fetching from provider APIs.
 *
 * Fetches available models after user enters API key,
 * falling back to hardcoded catalog on any error.
 */


export interface FetchedModel {
  id: string;
  name: string;
  contextLength?: number;
  isChatModel: boolean;
}

export interface ModelFetchResult {
  models: FetchedModel[];
  source: "live" | "cached" | "fallback";
  error?: string;
}

// ── OpenAI-compatible /v1/models ────────────────────────

const EXCLUDE_PATTERNS = [
  /embed/i, /whisper/i, /tts/i, /dall-e/i, /image/i,
  /moderation/i, /babbage/i, /davinci/i, /ada/i, /curie/i,
  /text-search/i, /code-search/i, /similarity/i,
  /rerank/i, /classify/i, /realtime/i, /audio/i, /video/i,
  /sora/i, /transcri/i, /translat/i,
];

export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
  options: {
    authHeader?: "bearer" | "x-api-key";
    timeout?: number;
  } = {},
): Promise<ModelFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeout ?? 8000,
  );

  try {
    const url = baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.authHeader === "x-api-key") {
      headers["x-api-key"] = apiKey;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${url}/models`, {
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      return { models: [], source: "fallback", error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const data = (await res.json()) as {
      data?: { id: string }[];
      models?: { id: string }[];
    };
    const raw = data.data ?? data.models ?? [];

    const chatModels = raw
      .filter((m) => !EXCLUDE_PATTERNS.some((p) => p.test(m.id)))
      .map((m) => ({
        id: m.id,
        name: formatModelName(m.id),
        isChatModel: true,
      }))
      .sort((a, b) => b.id.localeCompare(a.id));

    return { models: chatModels, source: "live" };
  } catch (err) {
    return {
      models: [],
      source: "fallback",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Anthropic /v1/models ────────────────────────────────

export async function fetchAnthropicModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return { models: [], source: "fallback", error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as {
      data?: { id: string; display_name?: string }[];
    };
    const raw = data.data ?? [];

    const models = raw.map((m) => ({
      id: m.id,
      name: m.display_name ?? formatModelName(m.id),
      isChatModel: true,
    }));

    return { models, source: "live" };
  } catch (err) {
    return {
      models: [],
      source: "fallback",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Google Gemini ───────────────────────────────────────

export async function fetchGeminiModels(
  apiKey: string,
): Promise<ModelFetchResult> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(5000) },
    );

    if (!res.ok) {
      return { models: [], source: "fallback", error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as {
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
    };
    const raw = data.models ?? [];

    const chatModels = raw
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .filter((m) => !m.name.includes("embedding"))
      .map((m) => ({
        id: m.name.replace("models/", ""),
        name: m.displayName ?? formatModelName(m.name),
        isChatModel: true,
      }));

    return { models: chatModels, source: "live" };
  } catch (err) {
    return {
      models: [],
      source: "fallback",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Ollama /api/tags ────────────────────────────────────

export async function fetchOllamaModels(
  baseUrl = "http://localhost:11434",
): Promise<ModelFetchResult> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      return { models: [], source: "fallback", error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as {
      models?: { name: string }[];
    };
    const raw = data.models ?? [];

    return {
      models: raw.map((m) => ({ id: m.name, name: m.name, isChatModel: true })),
      source: "live",
    };
  } catch {
    return { models: [], source: "fallback", error: "Ollama not running" };
  }
}

// ── Unified router ──────────────────────────────────────

export async function fetchModelsForProvider(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ModelFetchResult> {
  switch (providerId) {
    case "anthropic":
      return fetchAnthropicModels(apiKey);

    case "gemini":
      return fetchGeminiModels(apiKey);

    case "ollama":
      return fetchOllamaModels(baseUrl ?? "http://localhost:11434");

    case "lmstudio":
      return fetchOpenAICompatibleModels(
        baseUrl ?? "http://localhost:1234/v1",
        apiKey || "lm-studio",
      );

    // Cloud providers — auth too complex to auto-fetch
    case "bedrock":
    case "vertex":
    case "azure":
    // OpenCode — no /models listing endpoint; catalog is authoritative
    case "opencode-zen":
    case "opencode-go":
      return { models: [], source: "fallback" };

    // Copilot uses its own endpoint
    case "copilot":
      return fetchOpenAICompatibleModels(
        "https://api.githubcopilot.com",
        apiKey,
        { authHeader: "bearer" },
      );

    // All other OpenAI-compatible providers
    default:
      return fetchOpenAICompatibleModels(
        baseUrl ?? getDefaultBaseUrl(providerId),
        apiKey,
      );
  }
}

// ── Helpers ─────────────────────────────────────────────

export function formatModelName(id: string): string {
  return id
    .replace(/^(accounts\/fireworks\/models\/|models\/)/, "")
    .replace(/-(\d{8})$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function getDefaultBaseUrl(providerId: string): string {
  const URLS: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    groq: "https://api.groq.com/openai/v1",
    cerebras: "https://api.cerebras.ai/v1",
    together: "https://api.together.xyz/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
    openrouter: "https://openrouter.ai/api/v1",
    perplexity: "https://api.perplexity.ai",
    mistral: "https://api.mistral.ai/v1",
    deepseek: "https://api.deepseek.com/v1",
    moonshot: "https://api.moonshot.cn/v1",
    zai: "https://api.z.ai/api/paas/v4",
    minimax: "https://api.minimax.io/v1",
    cohere: "https://api.cohere.com/v2",
    grok: "https://api.x.ai/v1",
    "opencode-zen": "https://opencode.ai/zen/v1",
    "opencode-go": "https://opencode.ai/zen/go/v1",
  };
  return URLS[providerId] ?? "";
}
