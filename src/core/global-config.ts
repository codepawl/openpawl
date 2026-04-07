import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderName } from "../providers/types.js";

export interface ProviderConfigEntry {
  type: ProviderName;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  name?: string;
  authMethod?: "apikey" | "oauth" | "device-oauth" | "local" | "credentials";
  oauthToken?: string;
  refreshToken?: string;
  tokenExpiry?: number;
  githubToken?: string;
  copilotToken?: string;
  copilotTokenExpiry?: number;
  setupToken?: string; // deprecated: OAuth tokens not supported by Anthropic API
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  serviceAccountPath?: string;
  projectId?: string;
  apiVersion?: string;
  hasCredential?: boolean;
}

export interface OpenPawlGlobalConfig {
  version: 1;
  activeProvider?: string;
  activeModel?: string;
  meta?: {
    version: string;
    createdAt?: string;
    updatedAt?: string;
    setupVersion?: string;
  };
  managedGateway?: boolean;
  gatewayHost?: string;
  gatewayPort?: number;
  apiPort?: number;
  gatewayUrl?: string;
  apiUrl?: string;
  token?: string;
  model?: string;
  chatEndpoint?: string;
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
  webhookApproval?: {
    url?: string;
    secret?: string;
    provider?: "generic" | "slack";
    timeoutSeconds?: number;
    retryAttempts?: number;
  };
  handoff?: {
    autoGenerate?: boolean;
    outputPath?: string;
    keepHistory?: boolean;
    gitCommit?: boolean;
  };
  personality?: {
    enabled?: boolean;
    pushbackEnabled?: boolean;
    coordinatorIntervention?: boolean;
    agentOverrides?: Record<string, { enabled?: boolean }>;
  };
  tokenOptimization?: {
    promptCaching?: boolean;
    contextCompression?: {
      enabled?: boolean;
      thresholdChars?: number;
    };
    payloadOffloading?: {
      enabled?: boolean;
      thresholdChars?: number;
    };
    payloadCompression?: {
      enabled?: boolean;
      thresholdChars?: number;
    };
    semanticCache?: {
      enabled?: boolean;
      similarityThreshold?: number;
      ttlMinutes?: number;
    };
    modelRouting?: {
      enabled?: boolean;
      allowTierDowngrade?: boolean;
    };
    memoryTopK?: number;
  };
  timeouts?: {
    firstChunkMs: number;
    requestMs: number;
  };
  dashboard?: {
    port: number;
    persistent: boolean;
    autoOpen: boolean;
  };
  work?: {
    interactive: boolean;
    sessionCount: number;
  };
  streaming?: {
    enabled: boolean;
    showThinking: boolean;
  };
  providers?: ProviderConfigEntry[];
  workspaceDir?: string;
  proxy?: {
    path?: string;
    logLevel?: "debug" | "info" | "warn" | "error" | "fatal" | "trace" | "silent";
  };
  session?: {
    idleTimeoutMinutes?: number;
    checkpointIntervalMs?: number;
    autoArchiveDays?: number;
    maxHistoryMessages?: number;
  };
  router?: {
    defaultAgent?: string;
    maxParallelAgents?: number;
    confirmationThresholdUSD?: number;
    autoFollowUp?: boolean;
    showRoutingDecision?: boolean;
    customAgentsDir?: string;
  };
  tools?: {
    defaults?: Record<string, string>;
    mcp?: Array<{
      name: string;
      url: string;
      permission?: string;
    }>;
  };
}

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_CHAT_ENDPOINT = "/v1/chat/completions";
const DEFAULT_DASHBOARD_PORT = 9001;
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
  return path.join(os.homedir(), ".openpawl", "config.json");
}

function ensureGlobalConfigDir(): void {
  const dir = path.dirname(getGlobalConfigPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function buildDefaultGlobalConfig(): OpenPawlGlobalConfig {
  return {
    version: 1,
    dashboardPort: DEFAULT_DASHBOARD_PORT,
    debugMode: false,
  };
}

export function normalizeGlobalConfig(input: Partial<OpenPawlGlobalConfig>): OpenPawlGlobalConfig {
  const fromGatewayUrl =
    typeof input.gatewayUrl === "string" && input.gatewayUrl.trim()
      ? parseHostAndPortFromUrl(input.gatewayUrl)
      : {};

  const gatewayHost = normalizeHost(
    (typeof input.gatewayHost === "string" && input.gatewayHost.trim()) ||
      fromGatewayUrl.host ||
      DEFAULT_GATEWAY_HOST,
  );

  const gatewayPort = toPositiveInt(
    input.gatewayPort ?? fromGatewayUrl.port,
    DEFAULT_GATEWAY_PORT,
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

  const rawHandoff = (input as Record<string, unknown>).handoff;
  const handoffObj = rawHandoff && typeof rawHandoff === "object" && !Array.isArray(rawHandoff)
    ? (rawHandoff as Record<string, unknown>)
    : undefined;
  const handoff = handoffObj
    ? {
        autoGenerate: typeof handoffObj.autoGenerate === "boolean" ? handoffObj.autoGenerate : true,
        outputPath: typeof handoffObj.outputPath === "string" && handoffObj.outputPath.trim()
          ? handoffObj.outputPath.trim()
          : "./CONTEXT.md",
        keepHistory: typeof handoffObj.keepHistory === "boolean" ? handoffObj.keepHistory : true,
        gitCommit: typeof handoffObj.gitCommit === "boolean" ? handoffObj.gitCommit : false,
      }
    : undefined;

  const rawPersonality = (input as Record<string, unknown>).personality;
  const personalityObj = rawPersonality && typeof rawPersonality === "object" && !Array.isArray(rawPersonality)
    ? (rawPersonality as Record<string, unknown>)
    : undefined;
  const personality = personalityObj
    ? {
        enabled: typeof personalityObj.enabled === "boolean" ? personalityObj.enabled : true,
        pushbackEnabled: typeof personalityObj.pushbackEnabled === "boolean" ? personalityObj.pushbackEnabled : true,
        coordinatorIntervention: typeof personalityObj.coordinatorIntervention === "boolean" ? personalityObj.coordinatorIntervention : true,
        agentOverrides: (() => {
          const raw = personalityObj.agentOverrides;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
          const entries = Object.entries(raw as Record<string, unknown>)
            .map(([k, v]) => {
              if (v && typeof v === "object" && !Array.isArray(v)) {
                const obj = v as Record<string, unknown>;
                return [k, { enabled: typeof obj.enabled === "boolean" ? obj.enabled : true }] as const;
              }
              return null;
            })
            .filter((e): e is [string, { enabled: boolean }] => e !== null);
          return entries.length > 0 ? Object.fromEntries(entries) : undefined;
        })(),
      }
    : undefined;

  // Parse providers: ProviderConfigEntry[]
  const validProviderTypes = [
    "anthropic", "openai", "openrouter", "ollama", "deepseek", "groq", "custom",
    "chatgpt", "copilot", "gemini-oauth",
    "gemini", "grok", "mistral", "cerebras", "together", "fireworks",
    "perplexity", "moonshot", "zai", "minimax", "cohere",
    "opencode-zen", "opencode-go",
    "bedrock", "vertex", "azure", "lmstudio",
  ] as const;
  const rawProviders = (input as Record<string, unknown>).providers;
  const providers: ProviderConfigEntry[] | undefined = Array.isArray(rawProviders)
    ? (rawProviders as unknown[])
        .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
        .filter((v) => typeof v.type === "string" && (validProviderTypes as readonly string[]).includes(v.type))
        .map((v) => ({
          type: v.type as ProviderConfigEntry["type"],
          ...(typeof v.apiKey === "string" && v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : {}),
          ...(typeof v.baseURL === "string" && v.baseURL.trim() ? { baseURL: v.baseURL.trim() } : {}),
          ...(typeof v.model === "string" && v.model.trim() ? { model: v.model.trim() } : {}),
          ...(typeof v.name === "string" && v.name.trim() ? { name: v.name.trim() } : {}),
          ...(typeof v.authMethod === "string" ? { authMethod: v.authMethod as ProviderConfigEntry["authMethod"] } : {}),
          ...(typeof v.oauthToken === "string" && v.oauthToken.trim() ? { oauthToken: v.oauthToken.trim() } : {}),
          ...(typeof v.refreshToken === "string" && v.refreshToken.trim() ? { refreshToken: v.refreshToken.trim() } : {}),
          ...(typeof v.tokenExpiry === "number" ? { tokenExpiry: v.tokenExpiry } : {}),
          ...(typeof v.githubToken === "string" && v.githubToken.trim() ? { githubToken: v.githubToken.trim() } : {}),
          ...(typeof v.copilotToken === "string" && v.copilotToken.trim() ? { copilotToken: v.copilotToken.trim() } : {}),
          ...(typeof v.copilotTokenExpiry === "number" ? { copilotTokenExpiry: v.copilotTokenExpiry } : {}),
          ...(typeof v.setupToken === "string" && v.setupToken.trim() ? { setupToken: v.setupToken.trim() } : {}),
          ...(typeof v.accessKeyId === "string" && v.accessKeyId.trim() ? { accessKeyId: v.accessKeyId.trim() } : {}),
          ...(typeof v.secretAccessKey === "string" && v.secretAccessKey.trim() ? { secretAccessKey: v.secretAccessKey.trim() } : {}),
          ...(typeof v.sessionToken === "string" && v.sessionToken.trim() ? { sessionToken: v.sessionToken.trim() } : {}),
          ...(typeof v.region === "string" && v.region.trim() ? { region: v.region.trim() } : {}),
          ...(typeof v.serviceAccountPath === "string" && v.serviceAccountPath.trim() ? { serviceAccountPath: v.serviceAccountPath.trim() } : {}),
          ...(typeof v.projectId === "string" && v.projectId.trim() ? { projectId: v.projectId.trim() } : {}),
          ...(typeof v.apiVersion === "string" && v.apiVersion.trim() ? { apiVersion: v.apiVersion.trim() } : {}),
          ...(v.hasCredential !== undefined ? { hasCredential: Boolean(v.hasCredential) } : {}),
        }))
    : undefined;

  // Parse activeProvider and activeModel
  const activeProvider = typeof input.activeProvider === "string" && input.activeProvider.trim()
    ? input.activeProvider.trim()
    : providers && providers.length > 0
      ? providers[0].type
      : undefined;
  const activeModel = typeof input.activeModel === "string" && input.activeModel.trim()
    ? input.activeModel.trim()
    : model || undefined;

  // Parse tokenOptimization — pass through if present, no deep validation needed
  const rawTokenOpt = (input as Record<string, unknown>).tokenOptimization;
  const tokenOptimization = rawTokenOpt && typeof rawTokenOpt === "object" && !Array.isArray(rawTokenOpt)
    ? (rawTokenOpt as OpenPawlGlobalConfig["tokenOptimization"])
    : undefined;

  // Parse timeouts
  const rawTimeouts = asRecord((input as Record<string, unknown>).timeouts);
  const timeouts: OpenPawlGlobalConfig["timeouts"] | undefined =
    Object.keys(rawTimeouts).length > 0
      ? {
          firstChunkMs: toPositiveInt(rawTimeouts.firstChunkMs, 15000),
          requestMs: toPositiveInt(rawTimeouts.requestMs, 60000),
        }
      : undefined;

  // Parse dashboard config
  const rawDashboard = asRecord((input as Record<string, unknown>).dashboard);
  const dashboard: OpenPawlGlobalConfig["dashboard"] | undefined =
    Object.keys(rawDashboard).length > 0
      ? {
          port: toPositiveInt(rawDashboard.port, DEFAULT_DASHBOARD_PORT),
          persistent: typeof rawDashboard.persistent === "boolean" ? rawDashboard.persistent : true,
          autoOpen: typeof rawDashboard.autoOpen === "boolean" ? rawDashboard.autoOpen : false,
        }
      : undefined;

  // Parse work config
  const rawWork = asRecord((input as Record<string, unknown>).work);
  const work: OpenPawlGlobalConfig["work"] | undefined =
    Object.keys(rawWork).length > 0
      ? {
          interactive: typeof rawWork.interactive === "boolean" ? rawWork.interactive : true,
          sessionCount: toPositiveInt(rawWork.sessionCount, 0) || 0,
        }
      : undefined;

  // Parse streaming config
  const rawStreaming = asRecord((input as Record<string, unknown>).streaming);
  const streaming: OpenPawlGlobalConfig["streaming"] | undefined =
    Object.keys(rawStreaming).length > 0
      ? {
          enabled: typeof rawStreaming.enabled === "boolean" ? rawStreaming.enabled : true,
          showThinking: typeof rawStreaming.showThinking === "boolean" ? rawStreaming.showThinking : false,
        }
      : undefined;

  // Parse meta
  const rawMeta = asRecord((input as Record<string, unknown>).meta);
  const meta: OpenPawlGlobalConfig["meta"] | undefined =
    Object.keys(rawMeta).length > 0
      ? {
          version: typeof rawMeta.version === "string" ? rawMeta.version : "1",
          ...(typeof rawMeta.createdAt === "string" ? { createdAt: rawMeta.createdAt } : {}),
          ...(typeof rawMeta.updatedAt === "string" ? { updatedAt: rawMeta.updatedAt } : {}),
          ...(typeof rawMeta.setupVersion === "string" ? { setupVersion: rawMeta.setupVersion } : {}),
        }
      : undefined;

  // Gateway fields are optional — include only when present in input
  const gatewayFields: Partial<OpenPawlGlobalConfig> = {};
  if (typeof input.managedGateway === "boolean") gatewayFields.managedGateway = input.managedGateway;
  if (gatewayHost !== DEFAULT_GATEWAY_HOST || input.gatewayHost) gatewayFields.gatewayHost = gatewayHost;
  if (gatewayPort !== DEFAULT_GATEWAY_PORT || input.gatewayPort) {
    gatewayFields.gatewayPort = gatewayPort;
    gatewayFields.gatewayUrl = `ws://${gatewayHost}:${gatewayPort}`;
  }
  if (input.apiPort) {
    gatewayFields.apiPort = apiPort;
    gatewayFields.apiUrl = `http://${gatewayHost}:${apiPort}`;
  }
  if (token) gatewayFields.token = token;
  if (model) gatewayFields.model = model;
  if (chatEndpoint !== DEFAULT_CHAT_ENDPOINT || input.chatEndpoint) gatewayFields.chatEndpoint = chatEndpoint;

  return {
    version: 1,
    ...(activeProvider ? { activeProvider } : {}),
    ...(activeModel ? { activeModel } : {}),
    ...(meta ? { meta } : {}),
    ...gatewayFields,
    dashboardPort,
    debugMode,
    ...(agentModels && Object.keys(agentModels).length > 0 ? { agentModels } : {}),
    ...(modelAliases && Object.keys(modelAliases).length > 0 ? { modelAliases } : {}),
    ...(modelAllowlist && modelAllowlist.length > 0 ? { modelAllowlist } : {}),
    ...(fallbackChain && fallbackChain.length > 0 ? { fallbackChain } : {}),
    ...(handoff ? { handoff } : {}),
    ...(personality ? { personality } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(proxy ? { proxy } : {}),
    ...(tokenOptimization ? { tokenOptimization } : {}),
    ...(timeouts ? { timeouts } : {}),
    ...(dashboard ? { dashboard } : {}),
    ...(work ? { work } : {}),
    ...(streaming ? { streaming } : {}),
    ...(providers && providers.length > 0 ? { providers } : {}),
  };
}

export function readGlobalConfig(): OpenPawlGlobalConfig | null {
  const configPath = getGlobalConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = asRecord(JSON.parse(raw));
    return normalizeGlobalConfig(parsed as Partial<OpenPawlGlobalConfig>);
  } catch {
    return null;
  }
}

export function readGlobalConfigWithDefaults(): OpenPawlGlobalConfig {
  return readGlobalConfig() ?? buildDefaultGlobalConfig();
}

export function writeGlobalConfig(input: OpenPawlGlobalConfig): string {
  const normalized = normalizeGlobalConfig(input);

  // Automatically stamp meta.updatedAt on every write
  normalized.meta = {
    version: normalized.meta?.version ?? "1",
    createdAt: normalized.meta?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(normalized.meta?.setupVersion ? { setupVersion: normalized.meta.setupVersion } : {}),
  };

  ensureGlobalConfigDir();
  const configPath = getGlobalConfigPath();
  writeFileSync(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  return configPath;
}
