/**
 * OpenClaw provisioning - handshake before session to set up workspace.
 * TeamClaw POSTs context; OpenClaw (optional plugin) configures and returns ready.
 */

import { CONFIG } from "./config.js";

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

  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any response means gateway is reachable (even 404)
    if (res.ok || res.status === 401 || res.status === 403 || res.status === 404) {
      return { ok: true };
    }
    const text = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
