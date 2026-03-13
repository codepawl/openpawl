/**
 * LLM client - OpenClaw Gateway only (OpenAI-compatible).
 */

import { CONFIG, getSessionTemperature } from "./config.js";
import { logger, isDebugMode } from "./logger.js";
import { getTrafficController } from "./traffic-control.js";

export interface GenerateOptions {
  temperature?: number;
  model?: string;
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
  const model = options?.model ?? (await getEffectiveModel(workerUrl, CONFIG.openclawToken));

  if (!workerUrl) {
    trafficController.release(botId);
    throw new Error("❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.");
  }

  const url = buildOpenClawUrl(workerUrl, CONFIG.openclawChatEndpoint);
  const startedAt = Date.now();
  if (isDebugMode()) {
    logger.agent(
      `LLM request start: provider=openclaw url=${url} model=${model} timeoutMs=${timeoutMs} promptChars=${promptChars}`,
    );
  }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (CONFIG.openclawToken) {
      headers.Authorization = `Bearer ${CONFIG.openclawToken}`;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user" as const, content: prompt }],
        temperature,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Date.now() - startedAt;
    const statusLabel = typeof res.status === "number" ? String(res.status) : "unknown";
    if (isDebugMode()) {
      logger.agent(`LLM request end: provider=openclaw status=${statusLabel} elapsedMs=${elapsedMs}`);
    }
    if (!res.ok) {
      const textFn = (res as unknown as { text?: () => Promise<string> }).text;
      const body = typeof textFn === "function" ? (await textFn.call(res).catch(() => "")).trim() : "";
      const snippet = body.length > 0 ? ` body="${body.slice(0, 200)}"` : "";
      const portHint = res.status === 404
        ? ` ⚠️ 404 often means you are hitting the WS Gateway port instead of the API port. API port = Gateway port + 2 (e.g. 8001 → 8003). Run \`teamclaw setup\` to fix.`
        : "";
      trafficController.release(botId);
      throw new Error(`OpenClaw HTTP ${res.status}.${snippet}${portHint}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    trafficController.release(botId);
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } catch (err) {
    trafficController.release(botId);
    const elapsedMs = Date.now() - startedAt;
    if (isDebugMode()) {
      logger.agent(
        `LLM request error: provider=openclaw elapsedMs=${elapsedMs} timedOut=${isAbortTimeoutError(err)} err="${shortErr(err)}"`,
      );
    }
    throw new Error(
      `LLM OpenClaw request failed (url=${url}, model=${model}, timeoutMs=${timeoutMs}, elapsedMs=${elapsedMs}): ${shortErr(err)}`,
      { cause: err },
    );
  }
}

export async function llmHealthCheck(): Promise<boolean> {
  const workerUrl = CONFIG.openclawWorkerUrl?.trim();
  if (!workerUrl) return false;
  try {
    // Check the base API endpoint - any response means the gateway is reachable
    const url = buildOpenClawUrl(workerUrl, "");
    const headers: Record<string, string> = {};
    if (CONFIG.openclawToken) {
      headers.Authorization = `Bearer ${CONFIG.openclawToken}`;
    }
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    // Any response (even 401/403) means gateway is reachable
    return res.status !== 0;
  } catch {
    return false;
  }
}
