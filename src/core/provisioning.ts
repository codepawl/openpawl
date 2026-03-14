/**
 * OpenClaw provisioning - handshake before session to set up workspace.
 * TeamClaw POSTs context; OpenClaw (optional plugin) configures and returns ready.
 */

import { CONFIG } from "./config.js";
import { openclawEvents } from "./openclaw-events.js";

export interface ProvisionOptions {
  workerUrl: string;
  projectContext?: string;
  role?: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ProvisionResult {
  ok: boolean;
  error?: string;
}

function toProvisionHttpModelsUrl(workerUrl: string): string {
  const explicitHttp = (CONFIG.openclawHttpUrl ?? "").trim();
  if (explicitHttp) {
    return explicitHttp.replace(/\/$/, "");
  }

  const raw = workerUrl.trim().replace(/\/$/, "");
  const asHttp = raw.startsWith("wss://")
    ? raw.replace(/^wss:\/\//i, "https://")
    : raw.startsWith("ws://")
      ? raw.replace(/^ws:\/\//i, "http://")
      : raw;

  try {
    const parsed = new URL(asHttp);
    if (parsed.port) {
      const wsPort = Number(parsed.port);
      if (Number.isInteger(wsPort) && wsPort > 0) {
        parsed.port = String(wsPort + 2);
      }
    }
    return parsed.origin;
  } catch {
    return asHttp.replace(/\/$/, "");
  }
}

export async function provisionOpenClaw(options: ProvisionOptions): Promise<ProvisionResult> {
  const timeoutMs = options.timeoutMs ?? CONFIG.openclawProvisionTimeout;
  const url = toProvisionHttpModelsUrl(options.workerUrl);
  const headers: Record<string, string> = {};
  if (CONFIG.openclawToken) {
    headers.Authorization = `Bearer ${CONFIG.openclawToken}`;
  }

  openclawEvents.emit("log", {
    id: `prov-${Date.now()}-start`,
    level: "info",
    source: "llm-client",
    action: "provision_start",
    model: CONFIG.openclawModel ?? "",
    botId: "system",
    message: `Provisioning gateway → ${url}`,
    meta: { url, timeoutMs },
    timestamp: Date.now(),
  });

  try {
    const startedAt = Date.now();
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Date.now() - startedAt;
    // Any response means gateway is reachable (even 404)
    if (res.ok || res.status === 401 || res.status === 403 || res.status === 404) {
      openclawEvents.emit("log", {
        id: `prov-${Date.now()}-ok`,
        level: "success",
        source: "llm-client",
        action: "provision_end",
        model: CONFIG.openclawModel ?? "",
        botId: "system",
        message: `Gateway reachable (HTTP ${res.status}, ${elapsedMs}ms)`,
        meta: { status: res.status, elapsedMs },
        timestamp: Date.now(),
      });
      return { ok: true };
    }
    const text = await res.text();
    openclawEvents.emit("log", {
      id: `prov-${Date.now()}-fail`,
      level: "error",
      source: "llm-client",
      action: "provision_error",
      model: CONFIG.openclawModel ?? "",
      botId: "system",
      message: `Provisioning failed: HTTP ${res.status}`,
      meta: { status: res.status, elapsedMs, body: text.slice(0, 200) },
      timestamp: Date.now(),
    });
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    openclawEvents.emit("log", {
      id: `prov-${Date.now()}-err`,
      level: "error",
      source: "llm-client",
      action: "provision_error",
      model: CONFIG.openclawModel ?? "",
      botId: "system",
      message: `Provisioning failed: ${message}`,
      meta: { error: message },
      timestamp: Date.now(),
    });
    return { ok: false, error: message };
  }
}
