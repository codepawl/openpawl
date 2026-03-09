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

export async function provisionOpenClaw(options: ProvisionOptions): Promise<ProvisionResult> {
  const base = options.workerUrl.replace(/\/$/, "");
  if (/^wss?:\/\//i.test(base)) {
    // WS gateways may not expose HTTP /v1/models; treat transport as provisioned.
    return { ok: true };
  }
  const timeoutMs = options.timeoutMs ?? CONFIG.openclawProvisionTimeout;
  const url = base.includes("/v1") ? `${base}/models` : `${base}/v1/models`;
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
    if (res.ok) return { ok: true };
    const text = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
