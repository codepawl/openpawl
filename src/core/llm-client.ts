/**
 * LLM client - OpenClaw Gateway only (OpenAI-compatible).
 */

import { CONFIG, getSessionTemperature } from "./config.js";
import { logger, isDebugMode } from "./logger.js";
import { getTrafficController } from "./traffic-control.js";
import { resolveModelForAgent, getFallbackChain } from "./model-config.js";
import { openclawEvents } from "./openclaw-events.js";
import { getLlmCache } from "./llm-cache.js";

export interface GenerateOptions {
  temperature?: number;
  model?: string;
  stream?: boolean;
  onChunk?: (chunk: string) => void;
}

function isAbortTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name?: unknown }).name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

function shortErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

interface SSEResult {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function consumeSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void,
): Promise<SSEResult> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let accumulated = "";
  let usage: SSEResult["usage"];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          accumulated += content;
          onChunk?.(content);
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      } catch {
        // skip malformed JSON chunks
      }
    }
  }

  return { text: accumulated, usage };
}

/**
 * Derive an HTTP API base URL from a raw URL that may be a WebSocket gateway URL.
 *
 * OpenClaw port layout:
 *   WS  gateway  (e.g. 8001)  — WebSocket coordination
 *   API HTTP     (WS + 2, e.g. 8003) — OpenAI-compatible LLM endpoint
 *
 * Priority:
 *   1. OPENCLAW_HTTP_URL if set (explicitly configured by `teamclaw setup`)
 *   2. WS URL with port+2 offset (auto-derived)
 *   3. WS URL converted to HTTP with NO port change (last resort for non-standard setups)
 */
function deriveApiBaseUrl(wsOrHttpUrl: string): string {
    // Prefer the explicit API URL from config (set during setup)
    if (CONFIG.openclawHttpUrl?.trim()) {
        return CONFIG.openclawHttpUrl.trim().replace(/\/$/, "");
    }

    const raw = wsOrHttpUrl.trim().replace(/\/$/, "");
    // Convert WS scheme → HTTP scheme if needed
    const httpRaw = raw.startsWith("wss://")
        ? raw.replace(/^wss:\/\//i, "https://")
        : raw.startsWith("ws://")
            ? raw.replace(/^ws:\/\//i, "http://")
            : raw;

    // Apply +2 port offset only when the URL has an explicit port
    try {
        const parsed = new URL(httpRaw);
        if (parsed.port) {
            const apiPort = parseInt(parsed.port, 10) + 2;
            parsed.port = String(apiPort);
            return parsed.origin;
        }
    } catch {
        // fall through
    }
    return httpRaw;
}

function buildOpenClawUrl(wsOrHttpUrl: string, endpoint: string): string {
  const base = deriveApiBaseUrl(wsOrHttpUrl);
  const safeEndpoint = endpoint.trim() || "/v1/chat/completions";
  return new URL(safeEndpoint, `${base}/`).href;
}

async function discoverOpenClawModel(workerUrl: string, token: string): Promise<string | null> {
  const modelsUrl = buildOpenClawUrl(workerUrl, "/v1/models");
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ id?: string; name?: string }>;
      model?: string;
    };
    const firstDataModel = data.data?.find((m) => typeof m.id === "string" && m.id.trim().length > 0)?.id;
    if (firstDataModel) return firstDataModel.trim();
    const firstModelsModel = data.models?.find((m) =>
      typeof m.id === "string" || typeof m.name === "string") ?? null;
    if (firstModelsModel?.id && firstModelsModel.id.trim().length > 0) return firstModelsModel.id.trim();
    if (firstModelsModel?.name && firstModelsModel.name.trim().length > 0) return firstModelsModel.name.trim();
    if (typeof data.model === "string" && data.model.trim().length > 0) return data.model.trim();
    return null;
  } catch {
    return null;
  }
}

export async function getEffectiveModel(
  workerUrlOverride?: string,
  tokenOverride?: string,
): Promise<string> {
  const configured = CONFIG.openclawModel.trim();
  if (configured) return configured;
  const workerUrl = (workerUrlOverride ?? CONFIG.openclawWorkerUrl ?? "").trim();
  const token = (tokenOverride ?? CONFIG.openclawToken ?? "").trim();
  if (!workerUrl) {
    throw new Error("OPENCLAW_MODEL is not set and OPENCLAW_WORKER_URL is missing for model discovery.");
  }
  const discovered = await discoverOpenClawModel(workerUrl, token);
  if (!discovered) {
    throw new Error("OPENCLAW_MODEL is not set and could not be discovered from /v1/models.");
  }
  return discovered;
}

export async function generate(prompt: string, options?: GenerateOptions & { botId?: string }): Promise<string> {
  const botId = options?.botId ?? "coordinator";
  const trafficController = getTrafficController();

  const canProceed = await trafficController.acquire(botId);
  if (!canProceed) {
    throw new Error("Traffic control: Session paused due to safety limit. Please restart the work session.");
  }

  const workerUrl = CONFIG.openclawWorkerUrl?.trim();
  const temperature = options?.temperature ?? getSessionTemperature();
  const timeoutMs = CONFIG.llmTimeoutMs;
  const promptChars = prompt.length;
  const resolved = options?.model ?? resolveModelForAgent(botId);
  const model = resolved || (await getEffectiveModel(workerUrl, CONFIG.openclawToken));

  if (!workerUrl) {
    trafficController.release(botId);
    throw new Error("❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.");
  }

  // Cache check: skip streaming requests
  const isStreaming = !!options?.onChunk;
  if (!isStreaming) {
    const llmCache = getLlmCache();
    const cacheKey = llmCache.buildKey(prompt, model, temperature);
    const cached = llmCache.get(cacheKey);
    if (cached !== null) {
      openclawEvents.emit("log", {
        id: `llm-cache-hit-${Date.now()}`,
        level: "success",
        source: "llm-client",
        action: "cache_hit",
        model,
        botId,
        message: `Cache hit for ${botId} (${promptChars} chars saved)`,
        meta: { promptChars },
        timestamp: Date.now(),
      });
      trafficController.release(botId);
      return cached;
    }
  }

  const url = buildOpenClawUrl(workerUrl, CONFIG.openclawChatEndpoint);

  // Build model chain: primary model + fallback models (max 2 retries)
  const fallbacks = getFallbackChain();
  const modelChain = [model, ...fallbacks.filter((m) => m !== model)].slice(0, 3);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < modelChain.length; attempt++) {
    const currentModel = modelChain[attempt]!;
    const startedAt = Date.now();
    openclawEvents.emit("log", {
      id: `llm-${Date.now()}-${attempt}`,
      level: "info",
      source: "llm-client",
      action: "request_start",
      model: currentModel,
      botId,
      message: `LLM request → ${currentModel}${attempt > 0 ? ` (fallback #${attempt})` : ""}`,
      meta: { url, timeoutMs, promptChars, attempt },
      timestamp: Date.now(),
    });
    if (isDebugMode()) {
      logger.agent(
        `LLM request start: provider=openclaw url=${url} model=${currentModel} timeoutMs=${timeoutMs} promptChars=${promptChars}${attempt > 0 ? ` fallback=${attempt}` : ""}`,
      );
    }
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (CONFIG.openclawToken) {
        headers.Authorization = `Bearer ${CONFIG.openclawToken}`;
      }
      const useStreaming = !!(options?.onChunk);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: currentModel,
          messages: [{ role: "user" as const, content: prompt }],
          temperature,
          stream: useStreaming,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const elapsedMs = Date.now() - startedAt;
      const statusLabel = typeof res.status === "number" ? String(res.status) : "unknown";
      openclawEvents.emit("log", {
        id: `llm-${Date.now()}-${attempt}-end`,
        level: res.ok ? "success" : "warn",
        source: "llm-client",
        action: "request_end",
        model: currentModel,
        botId,
        message: res.ok ? `Response ${statusLabel} in ${elapsedMs}ms` : `HTTP ${statusLabel} from ${currentModel}`,
        meta: { status: res.status, elapsedMs },
        timestamp: Date.now(),
      });
      if (isDebugMode()) {
        logger.agent(`LLM request end: provider=openclaw status=${statusLabel} elapsedMs=${elapsedMs}`);
      }
      if (!res.ok) {
        const textFn = (res as unknown as { text?: () => Promise<string> }).text;
        const body = typeof textFn === "function" ? (await textFn.call(res).catch(() => "")).trim() : "";

        // Retry with fallback on 404 or model-not-found errors
        const isModelError = res.status === 404 || (res.status === 400 && body.toLowerCase().includes("model"));
        if (isModelError && attempt < modelChain.length - 1) {
          openclawEvents.emit("log", {
            id: `llm-${Date.now()}-${attempt}-fallback`,
            level: "warn",
            source: "llm-client",
            action: "fallback",
            model: currentModel,
            botId,
            message: `Model "${currentModel}" unavailable (${res.status}), falling back to ${modelChain[attempt + 1]}`,
            meta: { status: res.status, nextModel: modelChain[attempt + 1] },
            timestamp: Date.now(),
          });
          if (isDebugMode()) {
            logger.agent(`Model "${currentModel}" not available (${res.status}), trying fallback...`);
          }
          lastError = new Error(`OpenClaw HTTP ${res.status} for model ${currentModel}`);
          continue;
        }

        const snippet = body.length > 0 ? ` body="${body.slice(0, 200)}"` : "";
        const portHint = res.status === 404
          ? ` ⚠️ 404 often means you are hitting the WS Gateway port instead of the API port. API port = Gateway port + 2 (e.g. 8001 → 8003). Run \`teamclaw setup\` to fix.`
          : "";
        trafficController.release(botId);
        throw new Error(`OpenClaw HTTP ${res.status}.${snippet}${portHint}`);
      }
      if (useStreaming && res.body) {
        const sseResult = await consumeSSEStream(res.body, (chunk) => {
          options!.onChunk!(chunk);
          openclawEvents.emit("stream_chunk", {
            botId,
            model: currentModel,
            chunk,
            timestamp: Date.now(),
          });
        });
        trafficController.release(botId);
        return sseResult.text.trim();
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const responseText = (data.choices?.[0]?.message?.content ?? "").trim();
      // Cache successful non-streaming responses
      if (responseText) {
        const llmCache = getLlmCache();
        const storageKey = llmCache.buildKey(prompt, currentModel, temperature);
        llmCache.set(storageKey, responseText, promptChars, currentModel);
      }
      trafficController.release(botId);
      return responseText;
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      openclawEvents.emit("log", {
        id: `llm-${Date.now()}-${attempt}-error`,
        level: "error",
        source: "llm-client",
        action: "request_error",
        model: currentModel,
        botId,
        message: `Request failed: ${shortErr(err)}`,
        meta: { elapsedMs, timedOut: isAbortTimeoutError(err), error: shortErr(err) },
        timestamp: Date.now(),
      });
      if (isDebugMode()) {
        logger.agent(
          `LLM request error: provider=openclaw elapsedMs=${elapsedMs} timedOut=${isAbortTimeoutError(err)} err="${shortErr(err)}"`,
        );
      }
      lastError = err instanceof Error ? err : new Error(String(err));

      // Only retry on model-related errors, not timeouts or network failures
      if (attempt < modelChain.length - 1 && !isAbortTimeoutError(err)) {
        continue;
      }

      trafficController.release(botId);
      const wrapped = new Error(
        `LLM OpenClaw request failed (url=${url}, model=${currentModel}, timeoutMs=${timeoutMs}, elapsedMs=${elapsedMs}): ${shortErr(err)}`,
      );
      (wrapped as unknown as { cause: unknown }).cause = err;
      throw wrapped;
    }
  }

  trafficController.release(botId);
  throw lastError ?? new Error("LLM request failed: no models available");
}

export async function llmHealthCheck(): Promise<boolean> {
  const workerUrl = CONFIG.openclawWorkerUrl?.trim();
  if (!workerUrl) return false;
  try {
    // Hit /v1/models to validate the API endpoint, not just connectivity
    const url = buildOpenClawUrl(workerUrl, "/v1/models");
    const headers: Record<string, string> = {};
    if (CONFIG.openclawToken) {
      headers.Authorization = `Bearer ${CONFIG.openclawToken}`;
    }
    openclawEvents.emit("log", {
      id: `health-${Date.now()}`,
      level: "info",
      source: "llm-client",
      action: "health_check",
      model: CONFIG.openclawModel ?? "",
      botId: "system",
      message: `Health check → ${url}`,
      meta: { url },
      timestamp: Date.now(),
    });
    const startedAt = Date.now();
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const elapsedMs = Date.now() - startedAt;

    // Accept any non-5xx response as proof the gateway is alive.
    // Newer gateways serve an SPA (HTML) on all HTTP routes — that's fine,
    // it still proves the gateway process is running and reachable.
    const ok = res.status < 500;
    openclawEvents.emit("log", {
      id: `health-${Date.now()}-result`,
      level: ok ? "success" : "error",
      source: "llm-client",
      action: "health_check",
      model: CONFIG.openclawModel ?? "",
      botId: "system",
      message: ok ? `Gateway healthy (HTTP ${res.status}, ${elapsedMs}ms)` : `Health check failed (HTTP ${res.status})`,
      meta: { status: res.status, elapsedMs },
      timestamp: Date.now(),
    });
    return ok;
  } catch (err) {
    openclawEvents.emit("log", {
      id: `health-${Date.now()}-err`,
      level: "error",
      source: "llm-client",
      action: "health_check",
      model: CONFIG.openclawModel ?? "",
      botId: "system",
      message: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
      meta: { error: err instanceof Error ? err.message : String(err) },
      timestamp: Date.now(),
    });
    return false;
  }
}
