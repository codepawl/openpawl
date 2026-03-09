/**
 * Global configuration for TeamClaw.
 * Loads overrides from .env via dotenv.
 */

import "dotenv/config";
import { cancel, isCancel, note, password, select, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import type { TeamConfig } from "./team-config.js";
import { clearTeamConfigCache, loadTeamConfig } from "./team-config.js";
import { readEnvFile, writeEnvFile, getEnvValue, setEnvValue } from "./envManager.js";
import { readTeamclawConfig, writeTeamclawConfig } from "./jsonConfigManager.js";
import { discoverOpenAIApi } from "./discovery.js";

export type MemoryBackend = "lancedb" | "local_json";

function env(key: string, defaultVal: string): string;
function env(key: string, defaultVal: number): number;
function env(key: string, defaultVal: string | number): string | number {
  const val = process.env[key];
  if (val === undefined) return defaultVal;
  if (typeof defaultVal === "number") {
    const n = parseFloat(val);
    return Number.isInteger(defaultVal) ? Math.floor(n) : n;
  }
  return val;
}

function envBool(key: string, defaultVal: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultVal;
  return ["true", "1", "yes"].includes(val.toLowerCase());
}

function envMemoryBackend(defaultVal: MemoryBackend): MemoryBackend {
  const val = (process.env["MEMORY_BACKEND"] ?? "").trim().toLowerCase();
  if (val === "lancedb" || val === "local_json") return val;
  if (val === "chroma") return "lancedb";
  return defaultVal;
}

export const CONFIG = {
  llmTemperature: env("LLM_TEMPERATURE", 0.7) as number,
  creativity: env("CREATIVITY", 0.5) as number,
  llmTimeoutMs: env("LLM_TIMEOUT_MS", 120_000) as number,

  maxCycles: env("MAX_CYCLES", 10) as number,
  maxRuns: env("MAX_RUNS", env("MAX_GENERATIONS", 5) as number) as number,

  workspaceDir: env("WORKSPACE_DIR", "./teamclaw-workspace") as string,

  chromadbPersistDir: env("CHROMADB_PERSIST_DIR", "data/vector_store") as string,
  memoryBackend: envMemoryBackend("lancedb"),
  verboseLogging: envBool("VERBOSE_LOGGING", true),

  openclawWorkerUrl: env("OPENCLAW_WORKER_URL", "") as string,
  openclawWorkers: (() => {
    const raw = process.env["OPENCLAW_WORKERS"];
    if (!raw?.trim()) return {} as Record<string, string>;
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  })(),
  openclawToken: (process.env["OPENCLAW_TOKEN"] ?? process.env["OPENCLAW_AUTH_TOKEN"] ?? "").trim(),
  openclawChatEndpoint: (process.env["OPENCLAW_CHAT_ENDPOINT"] ?? "/v1/chat/completions").trim(),
  openclawModel: (process.env["OPENCLAW_MODEL"] ?? "").trim(),
  openclawProvisionTimeout: env("OPENCLAW_PROVISION_TIMEOUT", 30_000) as number,

  webhookOnTaskComplete: env("WEBHOOK_ON_TASK_COMPLETE", "") as string,
  webhookOnCycleEnd: env("WEBHOOK_ON_CYCLE_END", "") as string,
  webhookSecret: env("WEBHOOK_SECRET", "") as string,
} as const;

type MutableOpenClawRuntimeConfig = {
  openclawWorkerUrl: string;
  openclawToken: string;
  openclawChatEndpoint: string;
  openclawModel: string;
};

function applyRuntimeOpenClawConfig(update: Partial<MutableOpenClawRuntimeConfig>): void {
  const cfg = CONFIG as unknown as MutableOpenClawRuntimeConfig;
  if (typeof update.openclawWorkerUrl === "string") {
    process.env["OPENCLAW_WORKER_URL"] = update.openclawWorkerUrl;
    cfg.openclawWorkerUrl = update.openclawWorkerUrl;
  }
  if (typeof update.openclawToken === "string") {
    process.env["OPENCLAW_TOKEN"] = update.openclawToken;
    cfg.openclawToken = update.openclawToken;
  }
  if (typeof update.openclawChatEndpoint === "string") {
    process.env["OPENCLAW_CHAT_ENDPOINT"] = update.openclawChatEndpoint;
    cfg.openclawChatEndpoint = update.openclawChatEndpoint;
  }
  if (typeof update.openclawModel === "string") {
    process.env["OPENCLAW_MODEL"] = update.openclawModel;
    cfg.openclawModel = update.openclawModel;
  }
}

export interface SessionConfig {
  creativity?: number;
  max_cycles?: number;
  max_generations?: number;
  worker_url?: string;
  user_goal?: string;
  team_template?: string;
  approval_keywords?: string[];
  gateway_url?: string;
  team_model?: string;
}

const DEFAULT_APPROVAL_KEYWORDS = ["deploy", "release", "production", "critical"];

let sessionOverrides: Partial<SessionConfig> = {};

export function setSessionConfig(overrides: Partial<SessionConfig>): void {
  sessionOverrides = { ...overrides };
}

export function getApprovalKeywords(): string[] {
  return sessionOverrides.approval_keywords ?? DEFAULT_APPROVAL_KEYWORDS;
}

export function getSessionCreativity(): number {
  return sessionOverrides.creativity ?? CONFIG.creativity;
}

export function clearSessionConfig(): void {
  sessionOverrides = {};
}

function creativityToTemperature(creativity: number): number {
  return Math.max(0.2, Math.min(1.5, 0.3 + creativity * 0.9));
}

export function getSessionTemperature(): number {
  return creativityToTemperature(getSessionCreativity());
}

export function getGatewayUrl(): string {
  return sessionOverrides.gateway_url?.trim() ?? "";
}

export function getTeamModel(): string {
  return sessionOverrides.team_model?.trim() ?? "team-default";
}

export function getWorkspaceDir(): string {
  return CONFIG.workspaceDir;
}

export function getWorkerUrlsForTeam(
  botIds: string[],
  overrides?: { singleUrl?: string; workers?: Record<string, string> }
): Record<string, string> {
  if (overrides?.workers && Object.keys(overrides.workers).length > 0) {
    return overrides.workers;
  }
  const single = overrides?.singleUrl?.trim() ?? CONFIG.openclawWorkerUrl?.trim();
  if (single) {
    const out: Record<string, string> = {};
    for (const id of botIds) out[id] = single;
    return out;
  }
  if (Object.keys(CONFIG.openclawWorkers).length > 0) return CONFIG.openclawWorkers;
  return {};
}

function hasValidRoster(cfg: TeamConfig | null): boolean {
  const roster = cfg?.roster;
  if (!roster || roster.length === 0) return false;
  return roster.some(
    (r) =>
      r &&
      typeof r.role === "string" &&
      r.role.trim().length > 0 &&
      Number.isFinite(r.count) &&
      (r.count as number) >= 1,
  );
}

function handleInlineCancel<T>(v: T): T {
  if (isCancel(v)) {
    cancel("Setup cancelled.");
    throw new Error("Inline configuration cancelled by user");
  }
  return v;
}

function parsePortFromUrl(url: string): number | undefined {
  try {
    const withProtocol = url.includes("://") ? url : `http://${url}`;
    const parsed = new URL(withProtocol);
    if (!parsed.port) return undefined;
    const n = Number(parsed.port);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
  } catch {
    return undefined;
  }
}

async function discoverOpenClawModel(workerUrl: string, token: string): Promise<string | null> {
  const base = workerUrl.replace(/\/$/, "");
  const modelsUrl = `${/\/v1$/i.test(base) ? base : `${base}/v1`}/models`;
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ id?: string; name?: string }>;
      model?: string;
    };
    const firstDataModel = data.data?.find((m) => typeof m.id === "string" && m.id.trim().length > 0)?.id;
    if (firstDataModel) return firstDataModel.trim();
    const firstModelsModel = data.models?.find((m) =>
      typeof m.id === "string" || typeof m.name === "string") ?? null;
    if (firstModelsModel?.id && firstModelsModel.id.trim().length > 0) return firstModelsModel.id.trim();
    if (firstModelsModel?.name && firstModelsModel.name.trim().length > 0) return firstModelsModel.name.trim();
    if (typeof data.model === "string" && data.model.trim().length > 0) return data.model.trim();
    return null;
  } catch {
    return null;
  }
}

export async function validateOrPromptConfig(): Promise<void> {
  // Fast path: if everything already looks good, return immediately.
  const teamCfg = await loadTeamConfig();
  const rosterOk = hasValidRoster(teamCfg);

  const env = readEnvFile();
  const urlRaw = getEnvValue("OPENCLAW_WORKER_URL", env.lines);
  const tokenRaw = getEnvValue("OPENCLAW_TOKEN", env.lines);
  const chatEndpointRaw = getEnvValue("OPENCLAW_CHAT_ENDPOINT", env.lines);
  const modelRaw = getEnvValue("OPENCLAW_MODEL", env.lines);
  const openclawUrl = (urlRaw ?? "").trim();
  const openclawToken = (tokenRaw ?? "").trim();
  const openclawChatEndpoint =
    (chatEndpointRaw ?? "").trim() || (teamCfg?.openclaw_chat_endpoint ?? "").trim();
  const openclawModel =
    (modelRaw ?? "").trim() || (teamCfg?.openclaw_model ?? "").trim();

  let effectiveOpenclawUrl = openclawUrl;
  let effectiveOpenclawToken = openclawToken;
  let effectiveOpenclawChatEndpoint = openclawChatEndpoint;
  let effectiveOpenclawModel = openclawModel;
  let discoveredModels: string[] = [];

  if (rosterOk && openclawUrl && openclawToken && openclawChatEndpoint && openclawModel) {
    applyRuntimeOpenClawConfig({
      openclawWorkerUrl: openclawUrl,
      openclawToken: openclawToken,
      openclawChatEndpoint: openclawChatEndpoint,
      openclawModel: openclawModel,
    });
    return;
  }

  // Detect whether teamclaw.config.json exists / has content.
  const tc = readTeamclawConfig();
  const configEmpty = Object.keys(tc.data).length === 0;

  // If there is no project config at all yet, run the full onboarding wizard.
  if (configEmpty && !openclawUrl && !openclawToken && !openclawChatEndpoint && !openclawModel && !rosterOk) {
    note(
      "Welcome! Let's do a quick 10-second setup before we start working.",
      "TeamClaw setup",
    );
    const { runOnboard } = await import("../onboard/index.js");
    await runOnboard();
    clearTeamConfigCache();
    return;
  }

  // Otherwise, prompt only for missing scalar values here; leave rich roster
  // editing to the dedicated onboard flow if it's still missing.
  let envLines = env.lines;

  if (!effectiveOpenclawUrl || !effectiveOpenclawChatEndpoint || !effectiveOpenclawModel) {
    const s = spinner();
    s.start("📡 Scanning local network for OpenClaw API...");
    const discovered = await discoverOpenAIApi("http://localhost", {
      preferredPort: parsePortFromUrl(effectiveOpenclawUrl),
      timeoutMs: 1000,
    });
    if (discovered.length > 0) {
      let selected = discovered[0]!;
      if (discovered.length > 1) {
        const pickedPort = handleInlineCancel(
          await select({
            message: "Select detected OpenAI-compatible service:",
            options: discovered.map((d, idx) => ({
              value: String(idx),
              label: `Port ${d.port} [${d.protocol.toUpperCase()}] ${d.serviceName} - ${d.models.length} models`,
            })),
            initialValue: "0",
          }),
        ) as string;
        const parsedIdx = Number(pickedPort);
        selected =
          Number.isInteger(parsedIdx) && parsedIdx >= 0 && parsedIdx < discovered.length
            ? discovered[parsedIdx]!
            : selected;
      }
      discoveredModels = selected.protocol === "http" ? selected.models : [];
      s.stop(`✅ Found ${selected.serviceName} at port ${selected.port} (${selected.protocol.toUpperCase()})`);
      if (!effectiveOpenclawUrl) {
        effectiveOpenclawUrl = selected.baseUrl;
        envLines = setEnvValue("OPENCLAW_WORKER_URL", effectiveOpenclawUrl, envLines);
        applyRuntimeOpenClawConfig({ openclawWorkerUrl: effectiveOpenclawUrl });
      }
      if (!effectiveOpenclawChatEndpoint && selected.protocol === "http") {
        effectiveOpenclawChatEndpoint = selected.chatEndpoint;
        envLines = setEnvValue("OPENCLAW_CHAT_ENDPOINT", effectiveOpenclawChatEndpoint, envLines);
        applyRuntimeOpenClawConfig({ openclawChatEndpoint: effectiveOpenclawChatEndpoint });
      }
    } else {
      s.stop("⚠️ Could not auto-detect API.");
      note(
        [
          "Ensure you are pointing to the API port, not the Web UI port.",
          "For many setups, 8001 is a Web UI while API lives on another port.",
        ].join("\n"),
        "OpenClaw auto-discovery",
      );
    }
  }

  if (!openclawUrl) {
    const url = handleInlineCancel(
      await text({
        message: "Missing OpenClaw Gateway URL (OPENCLAW_WORKER_URL). Please enter it:",
        placeholder: "http://localhost:8001",
        validate: (v) =>
          ((v ?? "").trim().length > 0 ? undefined : "URL cannot be empty"),
      }),
    ) as string;
    const value = url.trim();
    if (value) {
      envLines = setEnvValue("OPENCLAW_WORKER_URL", value, envLines);
      effectiveOpenclawUrl = value;
      applyRuntimeOpenClawConfig({ openclawWorkerUrl: value });
    }
  }

  if (!openclawToken) {
    const token = handleInlineCancel(
      await password({
        message: "Missing OpenClaw token (OPENCLAW_TOKEN). Please enter it:",
        validate: (v) =>
          ((v ?? "").trim().length > 0 ? undefined : "Token cannot be empty"),
      }),
    ) as string;
    const value = token.trim();
    if (value) {
      envLines = setEnvValue("OPENCLAW_TOKEN", value, envLines);
      effectiveOpenclawToken = value;
      applyRuntimeOpenClawConfig({ openclawToken: value });
    }
  }

  if (!openclawChatEndpoint) {
    const endpoint = handleInlineCancel(
      await text({
        message: "Missing OpenClaw chat endpoint (OPENCLAW_CHAT_ENDPOINT). Please enter it:",
        initialValue: "/v1/chat/completions",
        placeholder: "/v1/chat/completions",
        validate: (v) =>
          ((v ?? "").trim().length > 0 ? undefined : "Endpoint cannot be empty"),
      }),
    ) as string;
    const value = endpoint.trim();
    if (value) {
      envLines = setEnvValue("OPENCLAW_CHAT_ENDPOINT", value, envLines);
      effectiveOpenclawChatEndpoint = value;
      applyRuntimeOpenClawConfig({ openclawChatEndpoint: value });
    }
  }

  if (!openclawModel) {
    if (discoveredModels.length > 0) {
      const selected = handleInlineCancel(
        await select({
          message: "Select an available model:",
          options: discoveredModels.map((m) => ({ value: m, label: m })),
          initialValue: discoveredModels[0],
        }),
      ) as string;
      const value = selected.trim();
      if (value) {
        envLines = setEnvValue("OPENCLAW_MODEL", value, envLines);
        effectiveOpenclawModel = value;
        applyRuntimeOpenClawConfig({ openclawModel: value });
      }
    } else {
      const discovered = effectiveOpenclawUrl
        ? await discoverOpenClawModel(effectiveOpenclawUrl, effectiveOpenclawToken)
        : null;
      const promptMessage = discovered
        ? `Missing OpenClaw model (OPENCLAW_MODEL). Discovered "${discovered}". Press Enter to accept or override:`
        : "Missing OpenClaw model (OPENCLAW_MODEL). Please enter it:";
      const model = handleInlineCancel(
        await text({
          message: promptMessage,
          initialValue: discovered ?? "",
          placeholder: "gpt-4o-mini",
          validate: (v) =>
            ((v ?? "").trim().length > 0 ? undefined : "Model cannot be empty"),
        }),
      ) as string;
      const value = model.trim();
      if (value) {
        envLines = setEnvValue("OPENCLAW_MODEL", value, envLines);
        effectiveOpenclawModel = value;
        applyRuntimeOpenClawConfig({ openclawModel: value });
      }
    }
  }

  if (envLines !== env.lines) {
    writeEnvFile(env.path, envLines);
  }

  // Ensure all resolved values are immediately available in this process even if
  // they came from existing .env/team config and no prompt branch executed.
  applyRuntimeOpenClawConfig({
    openclawWorkerUrl: effectiveOpenclawUrl,
    openclawToken: effectiveOpenclawToken,
    openclawChatEndpoint: effectiveOpenclawChatEndpoint,
    openclawModel: effectiveOpenclawModel,
  });

  const persisted = { ...tc.data } as Record<string, unknown>;
  let persistedChanged = false;
  if (effectiveOpenclawUrl && persisted["worker_url"] !== effectiveOpenclawUrl) {
    persisted["worker_url"] = effectiveOpenclawUrl;
    persistedChanged = true;
  }
  if (
    effectiveOpenclawChatEndpoint &&
    persisted["openclaw_chat_endpoint"] !== effectiveOpenclawChatEndpoint
  ) {
    persisted["openclaw_chat_endpoint"] = effectiveOpenclawChatEndpoint;
    persistedChanged = true;
  }
  if (effectiveOpenclawModel && persisted["openclaw_model"] !== effectiveOpenclawModel) {
    persisted["openclaw_model"] = effectiveOpenclawModel;
    persistedChanged = true;
  }
  if (persistedChanged) {
    writeTeamclawConfig(tc.path, persisted);
    clearTeamConfigCache();
  }

  // Ensure a basic roster exists; if not, create a minimal one-on-one config.
  if (!rosterOk) {
    note(
      [
        "Your project config is missing a team roster.",
        "We'll create a minimal default roster so you can start working,",
        "and you can refine it later via `teamclaw onboard` or `teamclaw config`.",
      ].join("\n"),
      "Missing roster",
    );

    const data = { ...tc.data };
    if (!Array.isArray((data as Record<string, unknown>).roster)) {
      (data as Record<string, unknown>).roster = [
        {
          role: "Engineer",
          count: 3,
          description: "Builds product features and infrastructure.",
        },
        {
          role: "Designer",
          count: 1,
          description: "Designs UX/UI and product visuals.",
        },
      ];
    }

    writeTeamclawConfig(tc.path, data);
    clearTeamConfigCache();
    const title = pc.green("Roster initialized");
    note(
      [
        "Created a default roster:",
        "- Engineer x3",
        "- Designer x1",
        "",
        "You can customize this later in `teamclaw.config.json` or via the onboarding wizard.",
      ].join("\n"),
      title,
    );
  }
}
