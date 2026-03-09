/**
 * LLM client - OpenClaw Gateway only (OpenAI-compatible).
 */

import { CONFIG, getSessionTemperature } from "./config.js";
import { logger } from "./logger.js";
import WebSocket from "ws";

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

function buildOpenClawUrl(baseUrl: string, endpoint: string): string {
  const raw = baseUrl.trim().replace(/\/$/, "");
  const base = raw.startsWith("ws://")
    ? raw.replace(/^ws:\/\//i, "http://")
    : raw.startsWith("wss://")
      ? raw.replace(/^wss:\/\//i, "https://")
      : raw;
  const safeEndpoint = endpoint.trim() || "/v1/chat/completions";
  return new URL(safeEndpoint, `${base}/`).href;
}

function isWsGateway(url: string): boolean {
  return /^wss?:\/\//i.test(url.trim());
}

function toWebSocketUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  const withProtocol = /^wss?:\/\//i.test(trimmed)
    ? trimmed
    : /^https?:\/\//i.test(trimmed)
      ? trimmed.replace(/^http/i, "ws")
      : `ws://${trimmed}`;
  const url = new URL(withProtocol);
  if (token.trim()) {
    url.searchParams.set("token", token.trim());
  }
  return url.href;
}

function authFrames(token: string): Array<Record<string, unknown>> {
  if (!token.trim()) return [];
  const t = token.trim();
  return [
    { type: "auth", token: t },
    { action: "auth", token: t },
    { type: "authenticate", token: t },
    { type: "auth", headers: { Authorization: `Bearer ${t}` } },
  ];
}

function extractWsCompletionText(msg: Record<string, unknown>): { done: boolean; text: string } | null {
  const type = String(msg.type ?? msg.event ?? "").toLowerCase();
  const action = String(msg.action ?? "").toLowerCase();
  const status = String(msg.status ?? "").toLowerCase();
  const success = typeof msg.success === "boolean" ? msg.success : undefined;

  if (type.includes("error") || action.includes("error") || status === "failed" || success === false) {
    const errorText = String(msg.error ?? msg.message ?? msg.reason ?? "WebSocket generation failed");
    throw new Error(errorText);
  }

  const choices = msg.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
    const content = first?.message?.content ?? first?.text;
    if (typeof content === "string" && content.trim().length > 0) {
      return { done: true, text: content.trim() };
    }
  }

  const maybeOutput =
    msg.output ??
    msg.result ??
    msg.content ??
    (typeof msg.message === "string" ? msg.message : null);
  const text = maybeOutput != null ? String(maybeOutput).trim() : "";
  const isDone =
    type.includes("complete") ||
    type.includes("done") ||
    type.includes("result") ||
    action.includes("complete") ||
    action.includes("done") ||
    status === "completed" ||
    typeof success === "boolean";

  if (isDone && text) return { done: true, text };
  if (text && !type.includes("token")) return { done: false, text };
  return null;
}

async function generateViaWebSocket(
  workerUrl: string,
  token: string,
  prompt: string,
  model: string,
  temperature: number,
  timeoutMs: number
): Promise<string> {
  const taskId = `LLM-${Date.now()}`;
  const wsUrl = toWebSocketUrl(workerUrl, token);
  return await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const frames: Array<Record<string, unknown>> = [
      {
        type: "chat.completions",
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        stream: false,
      },
      {
        type: "chat_completion",
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        stream: false,
      },
      {
        type: "generate",
        model,
        prompt,
        temperature,
      },
      {
        type: "execute_task",
        task_id: taskId,
        model,
        task: {
          task_id: taskId,
          description: prompt,
          priority: "medium",
          estimated_cost: 0,
        },
      },
      {
        action: "execute",
        task_id: taskId,
        model,
        description: prompt,
        priority: "medium",
        estimated_cost: 0,
      },
    ];

    let settled = false;
    let lastPartial = "";
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      fn();
    };

    const timer = setTimeout(() => {
      done(() => reject(new Error(`WebSocket LLM timeout (${timeoutMs}ms)`)));
    }, timeoutMs);

    ws.on("open", () => {
      for (const frame of authFrames(token)) ws.send(JSON.stringify(frame));
      for (const frame of frames) ws.send(JSON.stringify(frame));
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!msg) return;
      try {
        const hit = extractWsCompletionText(msg);
        if (!hit) return;
        if (hit.text) lastPartial = hit.text;
        if (hit.done) {
          done(() => resolve(hit.text || lastPartial || ""));
        }
      } catch (err) {
        done(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });

    ws.on("error", (err) => {
      done(() => reject(err instanceof Error ? err : new Error(String(err))));
    });

    ws.on("close", () => {
      if (!settled && lastPartial) {
        done(() => resolve(lastPartial));
      } else if (!settled) {
        done(() => reject(new Error("WebSocket closed before completion")));
      }
    });
  });
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

export async function generate(prompt: string, options?: GenerateOptions): Promise<string> {
  const workerUrl = CONFIG.openclawWorkerUrl?.trim();
  const temperature = options?.temperature ?? getSessionTemperature();
  const timeoutMs = CONFIG.llmTimeoutMs;
  const promptChars = prompt.length;
  const model = options?.model ?? (await getEffectiveModel(workerUrl, CONFIG.openclawToken));

  if (!workerUrl) {
    throw new Error("❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.");
  }

  const url = buildOpenClawUrl(workerUrl, CONFIG.openclawChatEndpoint);
  const startedAt = Date.now();
  if (CONFIG.verboseLogging) {
    logger.agent(
      `LLM request start: provider=openclaw url=${url} model=${model} timeoutMs=${timeoutMs} promptChars=${promptChars}`,
    );
  }
  try {
    if (isWsGateway(workerUrl)) {
      const output = await generateViaWebSocket(
        workerUrl,
        CONFIG.openclawToken ?? "",
        prompt,
        model,
        temperature,
        timeoutMs,
      );
      const elapsedMs = Date.now() - startedAt;
      if (CONFIG.verboseLogging) {
        logger.agent(`LLM request end: provider=openclaw protocol=ws elapsedMs=${elapsedMs}`);
      }
      return output.trim();
    }
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
    if (isWsGateway(workerUrl)) {
      const wsUrl = toWebSocketUrl(workerUrl, CONFIG.openclawToken ?? "");
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          reject(new Error("WebSocket health check timeout"));
        }, 5000);
        ws.on("open", () => {
          for (const frame of authFrames(CONFIG.openclawToken ?? "")) {
            ws.send(JSON.stringify(frame));
          }
          clearTimeout(timer);
          ws.close();
          resolve();
        });
        ws.on("unexpected-response", (_req, res) => {
          clearTimeout(timer);
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(`Unauthorized (HTTP ${res.statusCode})`));
            return;
          }
          reject(new Error(`Unexpected response ${res.statusCode ?? "unknown"}`));
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return true;
    }
    const url = buildOpenClawUrl(workerUrl, "/v1/models");
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
