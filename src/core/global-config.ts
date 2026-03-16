import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TeamClawGlobalConfig {
  version: 1;
  managedGateway: boolean;
  gatewayHost: string;
  gatewayPort: number;
  apiPort: number;
  gatewayUrl: string;
  apiUrl: string;
  token: string;
  model: string;
  chatEndpoint: string;
  dashboardPort: number;
  debugMode: boolean;
  agentModels?: Record<string, string>;
  modelAliases?: Record<string, string>;
  modelAllowlist?: string[];
  fallbackChain?: string[];
  confidenceScoring?: {
    enabled?: boolean;
    thresholds?: { autoApprove?: number; reviewRequired?: number; reworkRequired?: number };
  };
  workspaceDir?: string;
  proxy?: {
    path?: string;
    logLevel?: "debug" | "info" | "warn" | "error" | "fatal" | "trace" | "silent";
  };
}

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_CHAT_ENDPOINT = "/v1/chat/completions";
const DEFAULT_DASHBOARD_PORT = 9001;
const DEFAULT_OPENCLAW_MODEL = "";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseHostAndPortFromUrl(raw: string): { host?: string; port?: number } {
  try {
    const withScheme = raw.includes("://") ? raw : `http://${raw}`;
    const u = new URL(withScheme);
    const port = u.port ? Number(u.port) : undefined;
    const validPort = Number.isInteger(port) && (port as number) > 0
      ? (port as number)
      : undefined;
    return {
      host: u.hostname || undefined,
      port: validPort,
    };
  } catch {
    return {};
  }
}

function normalizeHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_GATEWAY_HOST;
  if (!trimmed.includes("://")) return trimmed;
  try {
    return new URL(trimmed).hostname || DEFAULT_GATEWAY_HOST;
  } catch {
    return DEFAULT_GATEWAY_HOST;
  }
}

export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), ".teamclaw", "config.json");
}

function ensureGlobalConfigDir(): void {
  const dir = path.dirname(getGlobalConfigPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function buildDefaultGlobalConfig(): TeamClawGlobalConfig {
  const gatewayHost = DEFAULT_GATEWAY_HOST;
  const gatewayPort = DEFAULT_GATEWAY_PORT;
  const apiPort = gatewayPort + 2;
  return {
    version: 1,
    managedGateway: true,
    gatewayHost,
    gatewayPort,
    apiPort,
    gatewayUrl: `ws://${gatewayHost}:${gatewayPort}`,
    apiUrl: `http://${gatewayHost}:${apiPort}`,
    token: "",
    model: DEFAULT_OPENCLAW_MODEL,
    chatEndpoint: DEFAULT_CHAT_ENDPOINT,
    dashboardPort: DEFAULT_DASHBOARD_PORT,
    debugMode: false,
  };
}

export function normalizeGlobalConfig(input: Partial<TeamClawGlobalConfig>): TeamClawGlobalConfig {
  const defaults = buildDefaultGlobalConfig();

  const fromGatewayUrl =
    typeof input.gatewayUrl === "string" && input.gatewayUrl.trim()
      ? parseHostAndPortFromUrl(input.gatewayUrl)
      : {};

  const gatewayHost = normalizeHost(
    (typeof input.gatewayHost === "string" && input.gatewayHost.trim()) ||
      fromGatewayUrl.host ||
      defaults.gatewayHost,
  );

  const gatewayPort = toPositiveInt(
    input.gatewayPort ?? fromGatewayUrl.port,
    defaults.gatewayPort,
  );

  const apiPort = toPositiveInt(input.apiPort, gatewayPort + 2);
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const chatEndpoint =
    typeof input.chatEndpoint === "string" && input.chatEndpoint.trim()
      ? input.chatEndpoint.trim()
      : DEFAULT_CHAT_ENDPOINT;
  const dashboardPort = toPositiveInt(input.dashboardPort, DEFAULT_DASHBOARD_PORT);
  const debugMode = typeof input.debugMode === "boolean" ? input.debugMode : false;

  // Parse agentModels: Record<string, string>
  const rawAgentModels = (input as Record<string, unknown>).agentModels;
  const agentModels: Record<string, string> | undefined =
    rawAgentModels && typeof rawAgentModels === "object" && !Array.isArray(rawAgentModels)
      ? Object.fromEntries(
          Object.entries(rawAgentModels as Record<string, unknown>)
            .map(([k, v]) => [k.trim().toLowerCase(), typeof v === "string" ? v.trim() : ""])
            .filter(([k, v]) => k.length > 0 && v.length > 0),
        )
      : undefined;

  // Parse modelAliases: Record<string, string>
  const rawModelAliases = (input as Record<string, unknown>).modelAliases;
  const modelAliases: Record<string, string> | undefined =
    rawModelAliases && typeof rawModelAliases === "object" && !Array.isArray(rawModelAliases)
      ? Object.fromEntries(
          Object.entries(rawModelAliases as Record<string, unknown>)
            .map(([k, v]) => [k.trim(), typeof v === "string" ? v.trim() : ""])
            .filter(([k, v]) => k.length > 0 && v.length > 0),
        )
      : undefined;

  // Parse modelAllowlist: string[]
  const rawAllowlist = (input as Record<string, unknown>).modelAllowlist;
  const modelAllowlist: string[] | undefined = Array.isArray(rawAllowlist)
    ? (rawAllowlist as unknown[])
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
    : undefined;

  // Parse fallbackChain: string[]
  const rawFallbackChain = (input as Record<string, unknown>).fallbackChain;
  const fallbackChain: string[] | undefined = Array.isArray(rawFallbackChain)
    ? (rawFallbackChain as unknown[])
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
    : undefined;

  const workspaceDir = typeof input.workspaceDir === "string" && input.workspaceDir.trim()
    ? input.workspaceDir.trim()
    : undefined;

  const rawProxy = (input as Record<string, unknown>).proxy;
  const proxyObj = rawProxy && typeof rawProxy === "object" && !Array.isArray(rawProxy)
    ? (rawProxy as Record<string, unknown>)
    : undefined;
  const proxy = proxyObj
    ? {
        path: typeof proxyObj.path === "string" && proxyObj.path.trim() ? proxyObj.path.trim() : "/proxy",
        logLevel: (() => {
          const valid: string[] = ["debug","info","warn","error","fatal","trace","silent"];
          const v = typeof proxyObj.logLevel === "string" ? proxyObj.logLevel.trim() : "";
          return (valid.includes(v) ? v : "info") as "debug" | "info" | "warn" | "error" | "fatal" | "trace" | "silent";
        })(),
      }
    : undefined;

  return {
    version: 1,
    managedGateway: typeof input.managedGateway === "boolean" ? input.managedGateway : true,
    gatewayHost,
    gatewayPort,
    apiPort,
    gatewayUrl: `ws://${gatewayHost}:${gatewayPort}`,
    apiUrl: `http://${gatewayHost}:${apiPort}`,
    token,
    model: model || DEFAULT_OPENCLAW_MODEL,
    chatEndpoint,
    dashboardPort,
    debugMode,
    ...(agentModels && Object.keys(agentModels).length > 0 ? { agentModels } : {}),
    ...(modelAliases && Object.keys(modelAliases).length > 0 ? { modelAliases } : {}),
    ...(modelAllowlist && modelAllowlist.length > 0 ? { modelAllowlist } : {}),
    ...(fallbackChain && fallbackChain.length > 0 ? { fallbackChain } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(proxy ? { proxy } : {}),
  };
}

export function readGlobalConfig(): TeamClawGlobalConfig | null {
  const configPath = getGlobalConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = asRecord(JSON.parse(raw));
    return normalizeGlobalConfig(parsed as Partial<TeamClawGlobalConfig>);
  } catch {
    return null;
  }
}

export function readGlobalConfigWithDefaults(): TeamClawGlobalConfig {
  return readGlobalConfig() ?? buildDefaultGlobalConfig();
}

export function writeGlobalConfig(input: TeamClawGlobalConfig): string {
  const normalized = normalizeGlobalConfig(input);
  ensureGlobalConfigDir();
  const configPath = getGlobalConfigPath();
  writeFileSync(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  return configPath;
}
