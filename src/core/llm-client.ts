/**
 * LLM client - OpenClaw Gateway only (OpenAI-compatible).
 */

import { CONFIG, getSessionTemperature } from "./config.js";
import { logger } from "./logger.js";

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

export async function generate(prompt: string, options?: GenerateOptions): Promise<string> {
  const workerUrl = CONFIG.openclawWorkerUrl?.trim();
  const temperature = options?.temperature ?? getSessionTemperature();
  const timeoutMs = CONFIG.llmTimeoutMs;
  const promptChars = prompt.length;
  const model = options?.model ?? "team-default";

  if (!workerUrl) {
    throw new Error("❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.");
  }

  const base = workerUrl.replace(/\/$/, "");
  const url = base.includes("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const startedAt = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.openclawToken) {
    headers.Authorization = `Bearer ${CONFIG.openclawToken}`;
  }
  if (CONFIG.verboseLogging) {
    logger.agent(
      `LLM request start: provider=openclaw url=${url} model=${model} timeoutMs=${timeoutMs} promptChars=${promptChars}`,
    );
  }
  try {
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
    if (CONFIG.verboseLogging) {
      logger.agent(`LLM request end: provider=openclaw status=${statusLabel} elapsedMs=${elapsedMs}`);
    }
    if (!res.ok) {
      const textFn = (res as unknown as { text?: () => Promise<string> }).text;
      const body = typeof textFn === "function" ? (await textFn.call(res).catch(() => "")).trim() : "";
      const snippet = body.length > 0 ? ` body="${body.slice(0, 200)}"` : "";
      throw new Error(`OpenClaw HTTP ${res.status}.${snippet}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    if (CONFIG.verboseLogging) {
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
    const base = workerUrl.replace(/\/$/, "");
    const url = base.includes("/v1") ? `${base}/models` : `${base}/v1/models`;
    const headers: Record<string, string> = {};
    if (CONFIG.openclawToken) {
      headers.Authorization = `Bearer ${CONFIG.openclawToken}`;
    }
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function getEffectiveModel(): string {
  return "team-default";
}
