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

function toHttpModelsUrl(rawUrl: string, explicitHttpUrl: string): string {
  // For health check, just ping the root endpoint - the gateway will respond
  // with 401 if auth is needed but that still proves connectivity
  if (explicitHttpUrl.trim()) {
    return explicitHttpUrl.trim().replace(/\/$/, "");
  }
  if (!rawUrl) return "";
  const withScheme = /^wss?:\/\//i.test(rawUrl)
    ? rawUrl
    : /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : `http://${rawUrl}`;
  const u = new URL(withScheme);
  if (u.protocol === "ws:") u.protocol = "http:";
  if (u.protocol === "wss:") u.protocol = "https:";

  // HTTP-first rule: WS gateway port hosts transport; API is port+2.
  if (u.port) {
    const basePort = Number(u.port);
    if (Number.isInteger(basePort) && basePort > 0) {
      u.port = String(basePort + 2);
    }
  }

  return u.href.replace(/\/$/, "");
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

  const started = Date.now();
  const modelsUrl = toHttpModelsUrl(gatewayUrl, httpApiUrl);
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    latency = Date.now() - started;
    // Accept any response (including 401/403) as proof of connectivity
    // Only network errors are actual failures
    if (res.status === 401 || res.status === 403) {
      authStatus = "invalid";
      checks.push({
        name: "auth",
        level: "fail",
        message: `Unauthorized (HTTP ${res.status})`,
        latencyMs: latency,
      });
      // Gateway is reachable even if auth failed
      checks.push({
        name: "ping",
        level: "pass",
        message: "Gateway reachable (auth needed)",
        latencyMs: latency,
      });
    } else if (!res.ok) {
      firstError = `HTTP ${res.status}`;
      checks.push({
        name: "ping",
        level: "fail",
        message: `Gateway/API responded with HTTP ${res.status}`,
        latencyMs: latency,
      });
    } else {
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
      // Try to parse models, but don't fail if it doesn't work
      try {
        const data = (await res.json()) as { data?: Array<{ id?: string }> };
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
        } else if (!models.includes(model)) {
          checks.push({
            name: "model",
            level: "fail",
            message: `Model "${model}" not found in provider`,
          });
        } else {
          checks.push({
            name: "model",
            level: "pass",
            message: `Model "${model}" is available`,
          });
        }
      } catch {
        // Model check optional - just skip if JSON parsing fails
        if (!model) {
          checks.push({
            name: "model",
            level: "warn",
            message: "OPENCLAW_MODEL is not set",
          });
        }
      }
    }
  } catch (err) {
    firstError = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "ping",
      level: "fail",
      message: firstError,
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
