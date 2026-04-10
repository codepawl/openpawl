/**
 * Centralized model resolution for OpenPawl.
 *
 * Resolution priority (highest → lowest):
 *   1. Per-agent runtime override (setAgentModel)
 *   2. Per-agent config from openpawl.config.json → agent_models
 *   3. Global config from ~/.openpawl/config.json → model
 *   4. Fallback: empty string (let provider decide)
 */

import {
  readGlobalConfig,
  buildDefaultGlobalConfig,
} from "./global-config.js";
import { getActiveModel as getProviderConfigModel } from "./provider-config.js";
import { recordTierDowngrade } from "../token-opt/stats.js";

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

// Runtime aliases (user-defined)
let runtimeAliases: Record<string, string> = {};

// Runtime allowlist (empty = allow all)
let runtimeAllowlist: string[] = [];

// Runtime fallback chain override
let runtimeFallbackChain: string[] | null = null;

// Active provider family — set by provider-factory after chain construction
let activeProviderFamily: "anthropic" | "openai" | "generic" = "generic";

/**
 * Tier-based model defaults for agents that don't need full-power models.
 * Applied only when no explicit per-agent config or global model is set.
 */
const TIER_DEFAULTS: Record<string, { anthropic: string; openai: string; generic: string }> = {
  // fast tier: execution agents that don't need deep reasoning
  tester:   { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini", generic: "" },
  debugger: { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini", generic: "" },
  // mini tier: bookkeeping / utility agents
  briefing:           { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini", generic: "" },
  standup:            { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini", generic: "" },
  "memory-promotion": { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini", generic: "" },
  "vibe-score":       { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini", generic: "" },
  "context-handoff":  { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini", generic: "" },
};

function resolveTierDefault(agentRole: string): string {
  const candidates = normalizeRole(agentRole);
  for (const role of candidates) {
    const tier = TIER_DEFAULTS[role];
    if (tier) {
      return tier[activeProviderFamily] || "";
    }
  }
  return "";
}

/**
 * Set the active provider family (called by provider-factory after chain build).
 */
export function setActiveProviderFamily(family: "anthropic" | "openai" | "generic"): void {
  activeProviderFamily = family;
}

/**
 * Get the current active provider family.
 */
export function getActiveProviderFamily(): "anthropic" | "openai" | "generic" {
  return activeProviderFamily;
}

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

  // Load from team config (openpawl.config.json) - synchronous read via cache
  // This is populated by loadTeamConfig() during startup and fed in via
  // setConfigAgentModels().
  return configAgentModels;
}

/**
 * Resolve alias: if modelOrAlias matches a known alias, return the target model.
 */
export function resolveAlias(modelOrAlias: string): string {
  const trimmed = modelOrAlias.trim();
  if (!trimmed) return trimmed;
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

  // Priority 2: Per-agent config (openpawl.config.json → agent_models)
  if (!resolved) {
    const cfgModels = loadConfigAgentModels();
    for (const role of candidates) {
      const cfgModel = cfgModels[role];
      if (cfgModel) { resolved = cfgModel; break; }
    }
  }

  // Priority 3: Global active model (via provider-config unified resolution)
  if (!resolved) {
    const globalModel = getProviderConfigModel();
    if (globalModel) resolved = globalModel;
  }

  // Priority 3.5: Tier-based default (cheaper model for utility agents)
  // Skip if model routing is disabled in config
  const modelRoutingEnabled =
    (readGlobalConfig() ?? buildDefaultGlobalConfig()).tokenOptimization?.modelRouting?.enabled ?? true;
  if (!resolved && modelRoutingEnabled) {
    const tierModel = resolveTierDefault(agentRole);
    if (tierModel) {
      resolved = tierModel;
      recordTierDowngrade(agentRole, tierModel);
    }
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
 * Get all known aliases (config + user-defined).
 */
export function getAliases(): Record<string, string> {
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
  const cfgModels = loadConfigAgentModels();
  const globalCfg = readGlobalConfig() ?? buildDefaultGlobalConfig();

  return {
    defaultModel: resolveModelForAgent("default"),
    agentModels: { ...cfgModels, ...runtimeAgentModels },
    fallbackChain: runtimeFallbackChain ?? globalCfg.fallbackChain ?? [],
    availableModels: [],
    aliases: { ...(globalCfg.modelAliases ?? {}), ...runtimeAliases },
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
  return [];
}

/**
 * List available models from configured providers.
 * Aggregates from model cache (fast) and provider catalog (fallback).
 */
export async function listAvailableModels(): Promise<string[]> {
  const globalCfg = readGlobalConfig();
  const providers = globalCfg?.providers ?? [];
  if (providers.length === 0) return [];

  const { getCachedModels } = await import("../providers/model-cache.js");
  const { PROVIDER_CATALOG } = await import("../providers/provider-catalog.js");

  const allModels = new Set<string>();

  for (const provider of providers) {
    // Try cache first (fast, no network)
    const cached = await getCachedModels(provider.type);
    if (cached && cached.length > 0) {
      for (const m of cached) allModels.add(m);
      continue;
    }

    // Fall back to catalog defaults
    const meta = PROVIDER_CATALOG[provider.type];
    if (meta?.models) {
      for (const m of meta.models) allModels.add(m.id);
    }
  }

  return [...allModels];
}

/**
 * Invalidate cached config (call after config reload).
 */
export function clearModelConfigCache(): void {
  configAgentModels = null;
  activeProviderFamily = "generic";

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
