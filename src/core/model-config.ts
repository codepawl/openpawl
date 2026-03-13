/**
 * Centralized model resolution for TeamClaw.
 *
 * Resolution priority (highest → lowest):
 *   1. Per-agent runtime override (setAgentModel)
 *   2. Per-agent config from teamclaw.config.json → agent_models
 *   3. Global runtime model (CONFIG.openclawModel)
 *   4. Global config from ~/.teamclaw/config.json → model
 *   5. OpenClaw primary from ~/.openclaw/openclaw.json → agents.defaults.model.primary
 *   6. Auto-discovery via /v1/models
 *   7. Fallback: empty string (let gateway decide)
 */

import { CONFIG } from "./config.js";
import { readLocalOpenClawConfig } from "./discovery.js";

export interface ModelConfig {
  defaultModel: string;
  agentModels: Record<string, string>;
  fallbackChain: string[];
  availableModels: string[];
}

// Runtime per-agent overrides (set via setAgentModel / CLI)
const runtimeAgentModels: Record<string, string> = {};

// Cached config-level agent models (loaded lazily from team + global config)
let configAgentModels: Record<string, string> | null = null;

// Cached OpenClaw config values
let openclawConfigCache: {
  primaryModel: string;
  fallbackChain: string[];
  availableModels: string[];
} | null = null;

/**
 * Normalize an agent role for lookup.
 * Worker bots have dynamic IDs like `programmer-1`. We check exact ID first,
 * then strip trailing `-N` for role prefix lookup, then try generic "worker".
 */
function normalizeRole(agentRole: string): string[] {
  const role = agentRole.trim().toLowerCase();
  if (!role) return ["default"];

  const candidates = [role];

  // Strip trailing -N for role prefix (e.g. programmer-1 → programmer)
  const stripped = role.replace(/-\d+$/, "");
  if (stripped !== role) {
    candidates.push(stripped);
  }

  // Generic worker fallback for any bot ID
  if (role !== "worker" && role !== "default") {
    candidates.push("worker");
  }

  candidates.push("default");
  return candidates;
}

function loadConfigAgentModels(): Record<string, string> {
  if (configAgentModels !== null) return configAgentModels;

  configAgentModels = {};

  // Load from team config (teamclaw.config.json) - synchronous read via cache
  // This is populated by loadTeamConfig() during startup and fed in via
  // setConfigAgentModels().
  return configAgentModels;
}

function loadOpenClawConfig(): typeof openclawConfigCache {
  if (openclawConfigCache !== null) return openclawConfigCache;

  const localCfg = readLocalOpenClawConfig();
  if (localCfg) {
    openclawConfigCache = {
      primaryModel: localCfg.model,
      fallbackChain: localCfg.fallbackModels,
      availableModels: localCfg.availableModels,
    };
  } else {
    openclawConfigCache = {
      primaryModel: "",
      fallbackChain: [],
      availableModels: [],
    };
  }

  return openclawConfigCache;
}

/**
 * Resolve the model to use for a given agent role.
 */
export function resolveModelForAgent(agentRole: string): string {
  const candidates = normalizeRole(agentRole);

  // Priority 1: Per-agent runtime override
  for (const role of candidates) {
    const runtime = runtimeAgentModels[role];
    if (runtime) return runtime;
  }

  // Priority 2: Per-agent config (teamclaw.config.json → agent_models)
  const cfgModels = loadConfigAgentModels();
  for (const role of candidates) {
    const cfgModel = cfgModels[role];
    if (cfgModel) return cfgModel;
  }

  // Priority 3: Global runtime model (CONFIG.openclawModel)
  const globalModel = CONFIG.openclawModel?.trim();
  if (globalModel) return globalModel;

  // Priority 4 is already folded into CONFIG.openclawModel via global-config.ts

  // Priority 5: OpenClaw primary model
  const ocCfg = loadOpenClawConfig();
  if (ocCfg?.primaryModel) return ocCfg.primaryModel;

  // Priority 6 & 7: Auto-discovery handled at call site; return empty to let gateway decide
  return "";
}

/**
 * Set a per-agent runtime model override.
 */
export function setAgentModel(agentRole: string, model: string): void {
  const role = agentRole.trim().toLowerCase();
  if (!role) return;
  if (model.trim()) {
    runtimeAgentModels[role] = model.trim();
  } else {
    delete runtimeAgentModels[role];
  }
}

/**
 * Set the default model (applies as the "default" agent role).
 */
export function setDefaultModel(model: string): void {
  setAgentModel("default", model);
}

/**
 * Bulk-set config-level agent models (called during config loading).
 */
export function setConfigAgentModels(models: Record<string, string>): void {
  configAgentModels = {};
  for (const [role, model] of Object.entries(models)) {
    const key = role.trim().toLowerCase();
    const val = model.trim();
    if (key && val) configAgentModels[key] = val;
  }
}

/**
 * Clear all runtime per-agent overrides.
 */
export function resetAgentModels(): void {
  for (const key of Object.keys(runtimeAgentModels)) {
    delete runtimeAgentModels[key];
  }
}

/**
 * Get the full model configuration snapshot.
 */
export function getModelConfig(): ModelConfig {
  const ocCfg = loadOpenClawConfig();
  const cfgModels = loadConfigAgentModels();

  return {
    defaultModel: resolveModelForAgent("default"),
    agentModels: { ...cfgModels, ...runtimeAgentModels },
    fallbackChain: ocCfg?.fallbackChain ?? [],
    availableModels: ocCfg?.availableModels ?? [],
  };
}

/**
 * Get the fallback chain for retry logic.
 */
export function getFallbackChain(): string[] {
  const ocCfg = loadOpenClawConfig();
  return ocCfg?.fallbackChain ?? [];
}

/**
 * List available models from OpenClaw config + discovery.
 */
export async function listAvailableModels(): Promise<string[]> {
  const ocCfg = loadOpenClawConfig();
  const fromConfig = ocCfg?.availableModels ?? [];

  // Also try /v1/models endpoint
  const fromApi = await discoverModelsFromApi();

  // Merge and deduplicate
  const all = [...fromConfig, ...fromApi];
  return [...new Set(all)].filter(Boolean);
}

async function discoverModelsFromApi(): Promise<string[]> {
  const workerUrl = CONFIG.openclawWorkerUrl?.trim();
  if (!workerUrl) return [];

  try {
    // Derive HTTP API URL (same logic as llm-client)
    let apiBase = CONFIG.openclawHttpUrl?.trim();
    if (!apiBase) {
      const raw = workerUrl.replace(/\/$/, "");
      const httpRaw = raw.startsWith("wss://")
        ? raw.replace(/^wss:\/\//i, "https://")
        : raw.startsWith("ws://")
          ? raw.replace(/^ws:\/\//i, "http://")
          : raw;
      try {
        const parsed = new URL(httpRaw);
        if (parsed.port) {
          parsed.port = String(parseInt(parsed.port, 10) + 2);
          apiBase = parsed.origin;
        } else {
          apiBase = httpRaw;
        }
      } catch {
        apiBase = httpRaw;
      }
    }

    const modelsUrl = new URL("/v1/models", `${apiBase.replace(/\/$/, "")}/`).href;
    const headers: Record<string, string> = {};
    if (CONFIG.openclawToken) {
      headers.Authorization = `Bearer ${CONFIG.openclawToken}`;
    }
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ id?: string; name?: string }>;
    };

    const models: string[] = [];
    if (data.data) {
      for (const m of data.data) {
        if (typeof m.id === "string" && m.id.trim()) models.push(m.id.trim());
      }
    }
    if (data.models) {
      for (const m of data.models) {
        const id = typeof m.id === "string" ? m.id.trim() : "";
        const name = typeof m.name === "string" ? m.name.trim() : "";
        if (id) models.push(id);
        else if (name) models.push(name);
      }
    }
    return [...new Set(models)];
  } catch {
    return [];
  }
}

/**
 * Invalidate cached config (call after config reload).
 */
export function clearModelConfigCache(): void {
  configAgentModels = null;
  openclawConfigCache = null;
}
