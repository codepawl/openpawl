import WebSocket from "ws";
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

function toHttpModelsUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  if (/^ws:\/\//i.test(rawUrl)) {
    const asHttp = rawUrl.replace(/^ws:\/\//i, "http://");
    return `${asHttp.replace(/\/$/, "")}/v1/models`;
  }
  if (/^wss:\/\//i.test(rawUrl)) {
    const asHttp = rawUrl.replace(/^wss:\/\//i, "https://");
    return `${asHttp.replace(/\/$/, "")}/v1/models`;
  }
  return `${rawUrl.replace(/\/$/, "")}/v1/models`;
}

function toWsUrl(rawUrl: string, token: string): string {
  if (!rawUrl) return "";
  const withScheme = /^wss?:\/\//i.test(rawUrl)
    ? rawUrl
    : /^https?:\/\//i.test(rawUrl)
      ? rawUrl.replace(/^http/i, "ws")
      : `ws://${rawUrl}`;
  const u = new URL(withScheme);
  if (token.trim()) u.searchParams.set("token", token.trim());
  return u.href;
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
    if (port === "8001") {
      return "Tip: Ensure OpenClaw gateway is running on port 8001.";
    }
    return "Tip: Check gateway host/port and network reachability.";
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

  if (protocol === "http") {
    const started = Date.now();
    const modelsUrl = toHttpModelsUrl(gatewayUrl);
    try {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(modelsUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      latency = Date.now() - started;
      if (res.status === 401 || res.status === 403) {
        authStatus = "invalid";
        checks.push({
          name: "auth",
          level: "fail",
          message: `Unauthorized (HTTP ${res.status})`,
          latencyMs: latency,
        });
      } else if (!res.ok) {
        firstError = `HTTP ${res.status}`;
        checks.push({
          name: "ping",
          level: "fail",
          message: `Gateway responded with HTTP ${res.status}`,
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
      }
    } catch (err) {
      firstError = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "ping",
        level: "fail",
        message: firstError,
      });
    }
  } else {
    const started = Date.now();
    try {
      const wsUrl = toWsUrl(gatewayUrl, token);
      const wsResult = await new Promise<{
        opened: boolean;
        authInvalid: boolean;
        reason?: string;
      }>((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          resolve({ opened: false, authInvalid: false, reason: "WebSocket timeout" });
        }, 5000);
        ws.on("open", () => {
          clearTimeout(timer);
          ws.send(JSON.stringify({ type: "auth", token }));
          ws.close();
          resolve({ opened: true, authInvalid: false });
        });
        ws.on("unexpected-response", (_req, res) => {
          clearTimeout(timer);
          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({
              opened: false,
              authInvalid: true,
              reason: `Unauthorized (HTTP ${res.statusCode})`,
            });
            return;
          }
          resolve({
            opened: false,
            authInvalid: false,
            reason: `Unexpected response ${res.statusCode ?? "unknown"}`,
          });
        });
        ws.on("error", (e) => {
          clearTimeout(timer);
          resolve({
            opened: false,
            authInvalid: false,
            reason: (e as Error)?.message ?? String(e),
          });
        });
      });
      latency = Date.now() - started;
      if (!wsResult.opened) {
        firstError = wsResult.reason ?? "WebSocket connection failed";
        if (wsResult.authInvalid) {
          authStatus = "invalid";
          checks.push({
            name: "auth",
            level: "fail",
            message: firstError,
            latencyMs: latency,
          });
        } else {
          checks.push({
            name: "ping",
            level: "fail",
            message: firstError,
            latencyMs: latency,
          });
        }
      } else {
        checks.push({
          name: "ping",
          level: "pass",
          message: "Gateway reachable via WebSocket",
          latencyMs: latency,
        });
        authStatus = token ? "valid" : "unknown";
        checks.push({
          name: "auth",
          level: token ? "pass" : "warn",
          message: token ? "Token provided for WS handshake" : "No token configured",
        });
        checks.push({
          name: "model",
          level: model ? "warn" : "warn",
          message: model
            ? "Model existence cannot be verified over WS-only preflight"
            : "OPENCLAW_MODEL is not set",
        });
      }
    } catch (err) {
      firstError = err instanceof Error ? err.message : String(err);
      checks.push({
        name: "ping",
        level: "fail",
        message: firstError,
      });
    }
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

