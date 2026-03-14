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
import {
  readGlobalConfig,
  writeGlobalConfig,
  buildDefaultGlobalConfig,
} from "./global-config.js";

export interface ModelConfig {
  defaultModel: string;
  agentModels: Record<string, string>;
  fallbackChain: string[];
  availableModels: string[];
  aliases: Record<string, string>;
  allowlist: string[];
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
  aliases: Record<string, string>;
} | null = null;

// Runtime aliases (user-defined + OpenClaw config)
let runtimeAliases: Record<string, string> = {};

// Runtime allowlist (empty = allow all)
let runtimeAllowlist: string[] = [];

// Runtime fallback chain override
let runtimeFallbackChain: string[] | null = null;

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
      aliases: localCfg.aliases ?? {},
    };
  } else {
    openclawConfigCache = {
      primaryModel: "",
      fallbackChain: [],
      availableModels: [],
      aliases: {},
    };
  }

  // Merge OpenClaw aliases into runtime aliases (user-defined take precedence)
  const merged = { ...(openclawConfigCache.aliases ?? {}), ...runtimeAliases };
  runtimeAliases = merged;

  return openclawConfigCache;
}

/**
 * Resolve alias: if modelOrAlias matches a known alias, return the target model.
 */
export function resolveAlias(modelOrAlias: string): string {
  const trimmed = modelOrAlias.trim();
  if (!trimmed) return trimmed;
  // Load to ensure OpenClaw aliases are populated
  loadOpenClawConfig();
  return runtimeAliases[trimmed] ?? trimmed;
}

/**
 * Check whether a model is allowed by the allowlist.
 * Empty allowlist means all models are allowed.
 */
export function isModelAllowed(model: string): boolean {
  if (runtimeAllowlist.length === 0) return true;
  return runtimeAllowlist.includes(model.trim());
}

/**
 * Resolve the model to use for a given agent role.
 */
export function resolveModelForAgent(agentRole: string): string {
  const candidates = normalizeRole(agentRole);

  let resolved = "";

  // Priority 1: Per-agent runtime override
  for (const role of candidates) {
    const runtime = runtimeAgentModels[role];
    if (runtime) { resolved = runtime; break; }
  }

  // Priority 2: Per-agent config (teamclaw.config.json → agent_models)
  if (!resolved) {
    const cfgModels = loadConfigAgentModels();
    for (const role of candidates) {
      const cfgModel = cfgModels[role];
      if (cfgModel) { resolved = cfgModel; break; }
    }
  }

  // Priority 3: Global runtime model (CONFIG.openclawModel)
  if (!resolved) {
    const globalModel = CONFIG.openclawModel?.trim();
    if (globalModel) resolved = globalModel;
  }

  // Priority 5: OpenClaw primary model
  if (!resolved) {
    const ocCfg = loadOpenClawConfig();
    if (ocCfg?.primaryModel) resolved = ocCfg.primaryModel;
  }

  // Resolve aliases
  if (resolved) {
    resolved = resolveAlias(resolved);
  }

  // Validate against allowlist; if blocked, try fallback chain
  if (resolved && !isModelAllowed(resolved)) {
    const chain = getFallbackChain();
    const allowed = chain.find((m) => isModelAllowed(resolveAlias(m)));
    if (allowed) {
      resolved = resolveAlias(allowed);
    }
    // If no fallback is allowed either, keep resolved (gateway may handle it)
  }

  return resolved;
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
 * Set a model alias (user-defined).
 */
export function setAlias(alias: string, model: string): void {
  runtimeAliases[alias.trim()] = model.trim();
}

/**
 * Remove a model alias.
 */
export function removeAlias(alias: string): void {
  delete runtimeAliases[alias.trim()];
}

/**
 * Get all known aliases (OpenClaw + user-defined).
 */
export function getAliases(): Record<string, string> {
  loadOpenClawConfig();
  return { ...runtimeAliases };
}

/**
 * Set the model allowlist. Empty array = allow all.
 */
export function setAllowlist(models: string[]): void {
  runtimeAllowlist = models.filter(Boolean);
}

/**
 * Get the current allowlist.
 */
export function getAllowlist(): string[] {
  return [...runtimeAllowlist];
}

/**
 * Set a runtime fallback chain override.
 */
export function setFallbackChain(models: string[]): void {
  runtimeFallbackChain = models.filter(Boolean);
}

/**
 * Get the full model configuration snapshot.
 */
export function getModelConfig(): ModelConfig {
  const ocCfg = loadOpenClawConfig();
  const cfgModels = loadConfigAgentModels();
  const globalCfg = readGlobalConfig() ?? buildDefaultGlobalConfig();

  return {
    defaultModel: resolveModelForAgent("default"),
    agentModels: { ...cfgModels, ...runtimeAgentModels },
    fallbackChain: runtimeFallbackChain ?? globalCfg.fallbackChain ?? ocCfg?.fallbackChain ?? [],
    availableModels: ocCfg?.availableModels ?? [],
    aliases: { ...(ocCfg?.aliases ?? {}), ...(globalCfg.modelAliases ?? {}), ...runtimeAliases },
    allowlist: runtimeAllowlist.length > 0 ? [...runtimeAllowlist] : [...(globalCfg.modelAllowlist ?? [])],
  };
}

/**
 * Get the fallback chain for retry logic.
 */
export function getFallbackChain(): string[] {
  if (runtimeFallbackChain && runtimeFallbackChain.length > 0) {
    return runtimeFallbackChain;
  }
  const globalCfg = readGlobalConfig();
  if (globalCfg?.fallbackChain && globalCfg.fallbackChain.length > 0) {
    return globalCfg.fallbackChain;
  }
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

  // Reload aliases/allowlist/fallback from global config
  const globalCfg = readGlobalConfig();
  if (globalCfg?.modelAliases) {
    runtimeAliases = { ...globalCfg.modelAliases };
  }
  if (globalCfg?.modelAllowlist) {
    runtimeAllowlist = [...globalCfg.modelAllowlist];
  }
  if (globalCfg?.fallbackChain) {
    runtimeFallbackChain = [...globalCfg.fallbackChain];
  }
}
