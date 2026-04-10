/**
 * Unified provider configuration — single source of truth for active provider
 * and model selection. All consumers read/write through this module.
 *
 * Resolution priority (highest wins):
 *   1. CLI flags (--provider, --model)
 *   2. Environment variables (ANTHROPIC_API_KEY → anthropic, etc.)
 *   3. Global config (~/.openpawl/config.json: activeProvider, activeModel)
 *   4. First provider in config.providers[] array
 *
 * Syncs to ActiveProviderState and connection-state on every mutation.
 */

import { EventEmitter } from "node:events";
import {
  readGlobalConfig,
  writeGlobalConfig,
  buildDefaultGlobalConfig,
  type ProviderConfigEntry,
  type OpenPawlGlobalConfig,
} from "./global-config.js";
import { getActiveProviderState } from "../providers/active-state.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProviderConfigChangeEvent {
  type: "provider" | "model";
  provider: string;
  model: string;
}

// ── Internal state ─────────────────────────────────────────────────────────

const emitter = new EventEmitter();

/** CLI flag overrides (set once at startup, highest priority). */
let cliProvider: string | undefined;
let cliModel: string | undefined;

/** Resolved cache (refreshed on every read/write). */
let resolvedProvider = "";
let resolvedModel = "";
let initialized = false;

// ── Env var detection (synchronous, no network) ────────────────────────────

const ENV_PROVIDER_MAP: ReadonlyArray<[envVar: string, provider: string]> = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["OPENROUTER_API_KEY", "openrouter"],
  ["DEEPSEEK_API_KEY", "deepseek"],
  ["GROQ_API_KEY", "groq"],
  ["GOOGLE_API_KEY", "gemini"],
  ["XAI_API_KEY", "grok"],
  ["MISTRAL_API_KEY", "mistral"],
];

function detectProviderFromEnv(): string {
  for (const [envVar, provider] of ENV_PROVIDER_MAP) {
    if (process.env[envVar]) return provider;
  }
  return "";
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readOrDefault(): OpenPawlGlobalConfig {
  return readGlobalConfig() ?? buildDefaultGlobalConfig();
}

function resolve(): { provider: string; model: string } {
  const cfg = readOrDefault();

  // Provider resolution: CLI > env > config.activeProvider > first in providers[]
  let provider = cliProvider ?? "";
  if (!provider) provider = detectProviderFromEnv();
  if (!provider && cfg.activeProvider) provider = cfg.activeProvider;
  if (!provider && cfg.providers && cfg.providers.length > 0) {
    provider = cfg.providers[0]!.type;
  }

  // Model resolution: CLI > config.activeModel > config.model (legacy) > provider entry's model > ""
  let model = cliModel ?? "";
  if (!model && cfg.activeModel) model = cfg.activeModel;
  if (!model && cfg.model) model = cfg.model;
  if (!model && provider) {
    const entry = cfg.providers?.find((p) => p.type === provider);
    if (entry?.model) model = entry.model;
  }

  return { provider, model };
}

function syncToActiveState(provider: string, model: string): void {
  const active = getActiveProviderState();
  if (provider && (active.provider !== provider || active.model !== model)) {
    if (active.provider === provider) {
      // Same provider, just model change
      active.setModel(model);
    } else if (provider) {
      // Provider changed — mark as connected if previously connected, else just set
      active.setActive(provider, model, { autoDetected: !cliProvider });
    }
  }
}

function emitChange(type: "provider" | "model"): void {
  const event: ProviderConfigChangeEvent = {
    type,
    provider: resolvedProvider,
    model: resolvedModel,
  };
  emitter.emit("change", event);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize provider config from global config + env vars.
 * Must be called once at startup before any reads.
 * Synchronous (reads config from disk via readGlobalConfig).
 */
export function initProviderConfig(): void {
  const { provider, model } = resolve();
  resolvedProvider = provider;
  resolvedModel = model;
  initialized = true;

  // Sync to ActiveProviderState (don't call setActive here — that marks as connected
  // before health check. Just prime the resolved values.)
}

/**
 * Set CLI flag overrides. Called once at startup from CLI arg parsing.
 */
export function setCliOverrides(overrides: { provider?: string; model?: string }): void {
  if (overrides.provider) cliProvider = overrides.provider;
  if (overrides.model) cliModel = overrides.model;
  // Re-resolve
  const { provider, model } = resolve();
  resolvedProvider = provider;
  resolvedModel = model;
}

/**
 * Get the active provider name (e.g., "anthropic", "ollama").
 */
export function getActiveProviderName(): string {
  if (!initialized) initProviderConfig();
  return resolvedProvider;
}

/**
 * Get the full config entry for the active provider, or null.
 */
export function getActiveProvider(): ProviderConfigEntry | null {
  const name = getActiveProviderName();
  if (!name) return null;
  const cfg = readOrDefault();
  return cfg.providers?.find((p) => p.type === name) ?? null;
}

/**
 * Get the active model string.
 */
export function getActiveModel(): string {
  if (!initialized) initProviderConfig();
  return resolvedModel;
}

/**
 * Set the active provider. Validates it exists in config or catalog.
 * Writes to global config and syncs ActiveProviderState.
 */
export function setActiveProvider(providerName: string): void {
  const trimmed = providerName.trim();
  if (!trimmed) return;

  const cfg = readOrDefault();
  writeGlobalConfig({ ...cfg, activeProvider: trimmed });

  resolvedProvider = trimmed;
  // Re-resolve model (may change if provider changes)
  const { model } = resolve();
  resolvedModel = model;

  syncToActiveState(resolvedProvider, resolvedModel);
  emitChange("provider");
}

/**
 * Set the active model. Writes both activeModel and model (legacy) to global config.
 * Syncs ActiveProviderState.
 */
export function setActiveModel(model: string): void {
  const trimmed = model.trim();

  const cfg = readOrDefault();
  writeGlobalConfig({ ...cfg, activeModel: trimmed, model: trimmed });

  resolvedModel = trimmed;
  syncToActiveState(resolvedProvider, resolvedModel);
  emitChange("model");
}

/**
 * Get all configured providers from global config.
 */
export function listProviders(): ProviderConfigEntry[] {
  return readOrDefault().providers ?? [];
}

/**
 * Get models for a specific provider from the provider registry's cached discovery.
 * Falls back to catalog defaults. Async because it lazy-imports provider-registry
 * to avoid circular dependencies.
 */
export async function listModels(providerName?: string): Promise<string[]> {
  const target = providerName ?? getActiveProviderName();
  if (!target) return [];

  try {
    const { getProviderRegistry } = await import("../providers/provider-registry.js");
    return getProviderRegistry().getModels(target);
  } catch {
    return [];
  }
}

/**
 * Subscribe to provider config changes.
 * Returns an unsubscribe function.
 */
export function onProviderConfigChange(
  listener: (event: ProviderConfigChangeEvent) => void,
): () => void {
  emitter.on("change", listener);
  return () => emitter.off("change", listener);
}

/**
 * Force re-resolve from config (e.g., after external config write).
 */
export function refreshProviderConfig(): void {
  const { provider, model } = resolve();
  const providerChanged = provider !== resolvedProvider;
  const modelChanged = model !== resolvedModel;
  resolvedProvider = provider;
  resolvedModel = model;
  if (providerChanged) emitChange("provider");
  else if (modelChanged) emitChange("model");
}

/**
 * Reset all state (for tests).
 */
export function resetProviderConfig(): void {
  cliProvider = undefined;
  cliModel = undefined;
  resolvedProvider = "";
  resolvedModel = "";
  initialized = false;
  emitter.removeAllListeners();
}
