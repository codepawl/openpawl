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
  const url = options.workerUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? CONFIG.openclawProvisionTimeout;
  const body: Record<string, unknown> = {
    project_context: options.projectContext,
    role: options.role,
    params: options.params,
  };

  try {
    const res = await fetch(`${url}/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
