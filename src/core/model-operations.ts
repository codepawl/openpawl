/**
 * Shared model persistence operations used by both `openpawl config`
 * and `openpawl model` commands.
 *
 * All persist* functions write to ~/.openpawl/config.json via writeGlobalConfig()
 * and update the runtime model-config layer.
 */

import {
  readGlobalConfig,
  writeGlobalConfig,
  buildDefaultGlobalConfig,
  type OpenPawlGlobalConfig,
} from "./global-config.js";
import { setActiveModel as setProviderActiveModel } from "./provider-config.js";
import {
  setDefaultModel,
  setAgentModel,
  resetAgentModels,
  setConfigAgentModels,
  clearModelConfigCache,
  getModelConfig,
  listAvailableModels,
  resolveModelForAgent,
} from "./model-config.js";

export interface ModelSummary {
  defaultModel: string;
  agentModels: Record<string, string>;
  fallbackChain: string[];
  aliases: Record<string, string>;
  allowlist: string[];
  availableModels: string[];
}

function readOrDefault(): OpenPawlGlobalConfig {
  return readGlobalConfig() ?? buildDefaultGlobalConfig();
}

export function persistDefaultModel(model: string): void {
  setDefaultModel(model);
  // Write through provider-config (syncs activeModel + legacy model + ActiveProviderState)
  setProviderActiveModel(model);
}

export function persistAgentModel(role: string, model: string): void {
  const normalizedRole = role.trim().toLowerCase();
  setAgentModel(normalizedRole, model);

  const existing = readOrDefault();
  const agentModels = { ...(existing.agentModels ?? {}) };

  if (model.trim()) {
    agentModels[normalizedRole] = model.trim();
  } else {
    delete agentModels[normalizedRole];
  }

  writeGlobalConfig({
    ...existing,
    agentModels: Object.keys(agentModels).length > 0 ? agentModels : undefined,
  });

  setConfigAgentModels(agentModels);
}

export function resetAllModelOverrides(): void {
  resetAgentModels();

  const existing = readOrDefault();
  if (existing.agentModels && Object.keys(existing.agentModels).length > 0) {
    const updated = { ...existing };
    delete updated.agentModels;
    writeGlobalConfig(updated);
  }

  clearModelConfigCache();
}

export function persistFallbackChain(chain: string[]): void {
  const existing = readOrDefault();
  writeGlobalConfig({ ...existing, fallbackChain: chain.filter(Boolean) });
  clearModelConfigCache();
}

export function persistAlias(alias: string, model: string): void {
  const existing = readOrDefault();
  const aliases = { ...(existing.modelAliases ?? {}) };
  aliases[alias.trim()] = model.trim();
  writeGlobalConfig({ ...existing, modelAliases: aliases });
  clearModelConfigCache();
}

export function removeAlias(alias: string): void {
  const existing = readOrDefault();
  const aliases = { ...(existing.modelAliases ?? {}) };
  delete aliases[alias.trim()];
  writeGlobalConfig({
    ...existing,
    modelAliases: Object.keys(aliases).length > 0 ? aliases : undefined,
  });
  clearModelConfigCache();
}

export function persistAllowlist(models: string[]): void {
  const existing = readOrDefault();
  writeGlobalConfig({
    ...existing,
    modelAllowlist: models.filter(Boolean).length > 0 ? models.filter(Boolean) : undefined,
  });
  clearModelConfigCache();
}

export async function getModelSummary(): Promise<ModelSummary> {
  const config = getModelConfig();
  const available = await listAvailableModels();
  const globalCfg = readOrDefault();

  return {
    defaultModel: config.defaultModel,
    agentModels: config.agentModels,
    fallbackChain: config.fallbackChain,
    aliases: { ...config.aliases, ...(globalCfg.modelAliases ?? {}) },
    allowlist: config.allowlist,
    availableModels: available,
  };
}

export { resolveModelForAgent };
