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

/**
 * Build a list of candidate HTTP URLs to probe for gateway liveness.
 * Newer gateways serve an SPA on the WS port, so we try multiple ports
 * and endpoints to find one that responds.
 */
function getCandidateUrls(workerUrl: string): string[] {
  const candidates: string[] = [];
  const explicitHttp = (CONFIG.openclawHttpUrl ?? "").trim();

  // Convert WS URL to HTTP base
  const raw = workerUrl.trim().replace(/\/$/, "");
  const asHttp = raw.startsWith("wss://")
    ? raw.replace(/^wss:\/\//i, "https://")
    : raw.startsWith("ws://")
      ? raw.replace(/^ws:\/\//i, "http://")
      : raw;

  let wsOrigin = asHttp;
  let apiOrigin = "";
  try {
    const parsed = new URL(asHttp);
    wsOrigin = parsed.origin;
    if (parsed.port) {
      const wsPort = Number(parsed.port);
      if (Number.isInteger(wsPort) && wsPort > 0) {
        parsed.port = String(wsPort + 2);
        apiOrigin = parsed.origin;
      }
    }
  } catch {
    // keep wsOrigin as-is
  }

  // Explicit HTTP URL gets highest priority
  if (explicitHttp) {
    candidates.push(`${explicitHttp.replace(/\/$/, "")}/v1/models`);
  }

  // API port (gateway + 2)
  if (apiOrigin) {
    candidates.push(`${apiOrigin}/v1/models`);
  }

  // WS/gateway port directly — newer gateways serve SPA here but respond to HTTP
  candidates.push(`${wsOrigin}/v1/models`);
  candidates.push(wsOrigin);

  // Deduplicate
  return [...new Set(candidates)];
}

export async function provisionOpenClaw(options: ProvisionOptions): Promise<ProvisionResult> {
  const timeoutMs = options.timeoutMs ?? CONFIG.openclawProvisionTimeout;
  const candidateUrls = getCandidateUrls(options.workerUrl);
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
    message: `Provisioning gateway → ${candidateUrls[0]}`,
    meta: { candidates: candidateUrls, timeoutMs },
    timestamp: Date.now(),
  });

  let lastError = "";

  for (const url of candidateUrls) {
    try {
      const startedAt = Date.now();
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const elapsedMs = Date.now() - startedAt;

      // Accept any non-5xx response as proof the gateway is reachable.
      // Newer gateways serve an SPA (HTML) on the WS port, so HTML is fine
      // as long as the server responded. A 404 from the Express CDP service
      // still counts — it proves the gateway process is running.
      if (res.status < 500) {
        openclawEvents.emit("log", {
          id: `prov-${Date.now()}-ok`,
          level: "success",
          source: "llm-client",
          action: "provision_end",
          model: CONFIG.openclawModel ?? "",
          botId: "system",
          message: `Gateway reachable (HTTP ${res.status}, ${elapsedMs}ms) via ${url}`,
          meta: { status: res.status, elapsedMs, url },
          timestamp: Date.now(),
        });
        return { ok: true };
      }

      lastError = `HTTP ${res.status} from ${url}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  openclawEvents.emit("log", {
    id: `prov-${Date.now()}-err`,
    level: "error",
    source: "llm-client",
    action: "provision_error",
    model: CONFIG.openclawModel ?? "",
    botId: "system",
    message: `Provisioning failed: ${lastError}`,
    meta: { error: lastError, candidates: candidateUrls },
    timestamp: Date.now(),
  });
  return { ok: false, error: lastError };
}
