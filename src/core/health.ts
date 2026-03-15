import { CONFIG } from "./config.js";

export type HealthLevel = "healthy" | "degraded" | "dead";
export type CheckLevel = "pass" | "warn" | "fail";

export interface HealthCheckResult {
  name: string;
  level: CheckLevel;
  message: string;
  latencyMs?: number;
}

export interface GatewayHealthReport {
  status: HealthLevel;
  gatewayUrl: string;
  protocol: "http" | "ws";
  latency: number;
  authStatus: "valid" | "invalid" | "unknown";
  checks: HealthCheckResult[];
  tip?: string;
}

/**
 * Build candidate HTTP URLs to probe for gateway liveness.
 * Newer gateways serve an SPA on the WS port, so we try multiple candidates.
 */
function getCandidateModelsUrls(rawUrl: string, explicitHttpUrl: string): string[] {
  const candidates: string[] = [];

  if (explicitHttpUrl.trim()) {
    candidates.push(`${explicitHttpUrl.trim().replace(/\/$/, "")}/v1/models`);
  }

  if (!rawUrl) return candidates;

  const withScheme = /^wss?:\/\//i.test(rawUrl)
    ? rawUrl
    : /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : `http://${rawUrl}`;
  const u = new URL(withScheme);
  if (u.protocol === "ws:") u.protocol = "http:";
  if (u.protocol === "wss:") u.protocol = "https:";

  // API port (gateway + 2) — traditional layout
  if (u.port) {
    const basePort = Number(u.port);
    if (Number.isInteger(basePort) && basePort > 0) {
      const apiUrl = new URL(u.href);
      apiUrl.port = String(basePort + 2);
      candidates.push(`${apiUrl.href.replace(/\/$/, "")}/v1/models`);
    }
  }

  // Gateway/WS port directly — newer gateways serve SPA here
  candidates.push(`${u.href.replace(/\/$/, "")}/v1/models`);
  candidates.push(u.href.replace(/\/$/, ""));

  return [...new Set(candidates)];
}

function inferTip(gatewayUrl: string, message: string): string | undefined {
  const lower = message.toLowerCase();
  const port = (() => {
    try {
      return new URL(
        gatewayUrl.includes("://") ? gatewayUrl : `http://${gatewayUrl}`
      ).port;
    } catch {
      return "";
    }
  })();
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized")) {
    return "Tip: Verify OPENCLAW_TOKEN and rerun `teamclaw config`.";
  }
  if (lower.includes("econnrefused") || lower.includes("timeout") || lower.includes("failed to fetch")) {
    if (port) {
      return `Tip: Run \`teamclaw run openclaw --port ${port}\` to start the gateway, or verify it's running on port ${port}.`;
    }
    return "Tip: Run `teamclaw run openclaw` to start the gateway, or check gateway host/port and network reachability.";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "Tip: You may be hitting the WS gateway port with HTTP. Use API port = gateway port + 2 (e.g. 8001 → 8003), or run `teamclaw setup`.";
  }
  return undefined;
}

function summarizeStatus(checks: HealthCheckResult[]): HealthLevel {
  if (checks.some((c) => c.level === "fail")) return "dead";
  if (checks.some((c) => c.level === "warn")) return "degraded";
  return "healthy";
}

export async function runGatewayHealthCheck(): Promise<GatewayHealthReport> {
  const gatewayUrl = (CONFIG.openclawWorkerUrl ?? "").trim();
  const httpApiUrl = (CONFIG.openclawHttpUrl ?? "").trim();
  const token = (CONFIG.openclawToken ?? "").trim();
  const model = (CONFIG.openclawModel ?? "").trim();
  const protocol: "http" | "ws" = /^wss?:\/\//i.test(gatewayUrl) ? "ws" : "http";
  const checks: HealthCheckResult[] = [];
  let latency = -1;
  let authStatus: "valid" | "invalid" | "unknown" = "unknown";
  let firstError = "";

  if (!gatewayUrl) {
    return {
      status: "dead",
      gatewayUrl: "(not set)",
      protocol: "http",
      latency: -1,
      authStatus: "unknown",
      checks: [{ name: "gateway", level: "fail", message: "OPENCLAW_WORKER_URL is not set" }],
      tip: "Tip: Run `teamclaw config` to set your gateway URL.",
    };
  }

  const candidateUrls = getCandidateModelsUrls(gatewayUrl, httpApiUrl);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  // Try each candidate URL until one succeeds
  let reachable = false;
  let successRes: Response | null = null;
  let successUrl = "";

  for (const url of candidateUrls) {
    try {
      const started = Date.now();
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      latency = Date.now() - started;

      // Accept any non-5xx response as proof of connectivity.
      // Newer gateways serve an SPA (HTML) on the WS port — that's fine.
      if (res.status < 500) {
        reachable = true;
        successRes = res;
        successUrl = url;
        break;
      }

      if (!firstError) firstError = `HTTP ${res.status} from ${url}`;
    } catch (err) {
      if (!firstError) firstError = err instanceof Error ? err.message : String(err);
    }
  }

  if (!reachable || !successRes) {
    checks.push({
      name: "ping",
      level: "fail",
      message: firstError || "Gateway unreachable on all candidate URLs",
    });
    const status = summarizeStatus(checks);
    return {
      status,
      gatewayUrl,
      protocol,
      latency,
      authStatus,
      checks,
      tip: firstError ? inferTip(gatewayUrl, firstError) : undefined,
    };
  }

  // We got a response — analyze it
  if (successRes.status === 401 || successRes.status === 403) {
    authStatus = "invalid";
    checks.push({
      name: "auth",
      level: "fail",
      message: `Unauthorized (HTTP ${successRes.status})`,
      latencyMs: latency,
    });
    checks.push({
      name: "ping",
      level: "pass",
      message: "Gateway reachable (auth needed)",
      latencyMs: latency,
    });
  } else if (successRes.status === 404) {
    // 404 still proves gateway process is running (e.g. CDP service on port+2)
    authStatus = token ? "unknown" : "unknown";
    checks.push({
      name: "ping",
      level: "pass",
      message: `Gateway process reachable (HTTP 404 at ${successUrl})`,
      latencyMs: latency,
    });
  } else if (successRes.ok) {
    authStatus = token ? "valid" : "unknown";
    checks.push({
      name: "ping",
      level: "pass",
      message: "Gateway reachable via HTTP",
      latencyMs: latency,
    });
    if (token) {
      checks.push({
        name: "auth",
        level: "pass",
        message: "Token accepted",
      });
    }
    // Try to parse models from a JSON response
    const contentType = successRes.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const data = (await successRes.json()) as { data?: Array<{ id?: string }> };
        const models =
          data.data
            ?.map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
            .filter(Boolean) ?? [];
        if (!model) {
          checks.push({
            name: "model",
            level: "warn",
            message: "OPENCLAW_MODEL is not set",
          });
        } else if (models.length > 0 && !models.includes(model)) {
          checks.push({
            name: "model",
            level: "fail",
            message: `Model "${model}" not found in provider`,
          });
        } else if (models.length > 0) {
          checks.push({
            name: "model",
            level: "pass",
            message: `Model "${model}" is available`,
          });
        }
      } catch {
        // JSON parsing failed — skip model check
      }
    } else {
      // Got HTML or other non-JSON (SPA gateway) — skip model validation
      if (!model) {
        checks.push({
          name: "model",
          level: "warn",
          message: "OPENCLAW_MODEL is not set",
        });
      }
    }
  } else {
    // Non-OK but < 500
    checks.push({
      name: "ping",
      level: "pass",
      message: `Gateway reachable (HTTP ${successRes.status})`,
      latencyMs: latency,
    });
  }

  const status = summarizeStatus(checks);
  return {
    status,
    gatewayUrl,
    protocol,
    latency,
    authStatus,
    checks,
    tip: firstError ? inferTip(gatewayUrl, firstError) : undefined,
  };
}
