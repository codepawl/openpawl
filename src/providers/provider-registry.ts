/**
 * ProviderRegistry — centralized source of truth for all provider definitions,
 * configuration, and runtime state.
 *
 * Coordinates between:
 * - PROVIDER_CATALOG (static metadata)
 * - Global config (persisted provider entries)
 * - Model discovery (live model lists)
 * - Active provider state (what's selected now)
 *
 * Does NOT duplicate existing logic — delegates to the subsystems above.
 */

import { EventEmitter } from "node:events";
import {
  getProviderMeta,
  getAllProviderIds,
  type ProviderMeta,
  type ProviderCategory,
} from "./provider-catalog.js";
import {
  readGlobalConfig,
  writeGlobalConfig,
  type ProviderConfigEntry,
} from "../core/global-config.js";
import {
  discoverModels,
  invalidateModelCache,
  type DiscoveredModel,
} from "./model-discovery.js";
import { getActiveProviderState } from "./active-state.js";
import type { ProviderName } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProviderDefinition {
  /** Unique provider ID (e.g. "anthropic", "ollama"). */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Provider category for UI grouping. */
  category: ProviderCategory;
  /** Whether this provider supports live model listing (Ollama, LM Studio). */
  supportsModelListing: boolean;
  /** Default/known models from catalog. */
  defaultModels: string[];
  /** Auth method used. */
  authMethod: ProviderMeta["authMethod"];
  /** Whether it's OpenAI-compatible. */
  openaiCompatible: boolean;
  /** URL for obtaining an API key. */
  keyUrl?: string;
}

export interface ProviderRuntimeState {
  /** Whether this provider has config (API key, etc.). */
  configured: boolean;
  /** Whether the provider is reachable (health check passed). */
  available: boolean;
  /** Currently known models (from discovery or defaults). */
  models: string[];
  /** Active model for this provider, if it's the selected provider. */
  activeModel: string | null;
}

// ─── Registry ───────────────────────────────────────────────────────────────

/** Providers that support live model listing via their API. */
const LISTABLE_PROVIDERS = new Set<string>(["ollama", "lmstudio", "custom"]);

export class ProviderRegistry extends EventEmitter {
  /** Cached runtime state per provider. */
  private runtimeCache = new Map<string, ProviderRuntimeState>();
  /** Last discovery result. */
  private lastDiscovery: DiscoveredModel[] = [];

  // ─── Definitions (static) ─────────────────────────────────────

  /** Get all provider definitions. */
  getAll(): ProviderDefinition[] {
    return getAllProviderIds().map((id) => this.getDefinition(id)!);
  }

  /** Get a single provider definition by ID. */
  getDefinition(id: string): ProviderDefinition | null {
    const meta = getProviderMeta(id);
    if (!meta) return null;
    return {
      id,
      displayName: meta.name,
      category: meta.category,
      supportsModelListing: LISTABLE_PROVIDERS.has(id),
      defaultModels: meta.models.map((m) => m.id),
      authMethod: meta.authMethod,
      openaiCompatible: meta.openaiCompatible,
      keyUrl: meta.keyUrl,
    };
  }

  /** Get definitions filtered by category. */
  getByCategory(category: ProviderCategory): ProviderDefinition[] {
    return this.getAll().filter((d) => d.category === category);
  }

  // ─── Configuration (persisted) ────────────────────────────────

  /** Get all configured provider entries from global config. */
  getConfigured(): ProviderDefinition[] {
    const entries = this.getConfigEntries();
    return entries
      .map((e) => this.getDefinition(e.type))
      .filter((d): d is ProviderDefinition => d !== null);
  }

  /** Get the raw config entry for a provider. */
  getConfig(providerId: string): ProviderConfigEntry | null {
    return this.getConfigEntries().find((e) => e.type === providerId) ?? null;
  }

  /** Set or update config for a provider. Persists to global config. */
  setConfig(providerId: string, config: Partial<ProviderConfigEntry>): void {
    const globalCfg = readGlobalConfig();
    if (!globalCfg) return;

    const providers = [...(globalCfg.providers ?? [])];
    const idx = providers.findIndex((p) => p.type === providerId);
    const entry: ProviderConfigEntry = {
      ...(idx >= 0 ? providers[idx] : {}),
      ...config,
      type: providerId as ProviderName,
    };

    if (idx >= 0) {
      providers[idx] = entry;
    } else {
      providers.push(entry);
    }

    writeGlobalConfig({ ...globalCfg, providers });
    this.clearRuntimeCache(providerId);
    this.emit("config:changed", providerId);
  }

  /** Remove a provider from config. */
  removeConfig(providerId: string): void {
    const globalCfg = readGlobalConfig();
    if (!globalCfg) return;

    const providers = (globalCfg.providers ?? []).filter((p) => p.type !== providerId);
    writeGlobalConfig({ ...globalCfg, providers });
    this.clearRuntimeCache(providerId);
    this.emit("config:changed", providerId);
  }

  // ─── Runtime State ────────────────────────────────────────────

  /** Get runtime state for a provider (uses cached discovery). */
  getState(providerId: string): ProviderRuntimeState {
    const cached = this.runtimeCache.get(providerId);
    if (cached) return cached;

    const configEntry = this.getConfig(providerId);
    const active = getActiveProviderState();
    const discoveredModels = this.lastDiscovery
      .filter((m) => m.provider === providerId)
      .map((m) => m.model);
    const def = this.getDefinition(providerId);

    const state: ProviderRuntimeState = {
      configured: configEntry !== null,
      available: discoveredModels.length > 0,
      models: discoveredModels.length > 0
        ? discoveredModels
        : (def?.defaultModels ?? []),
      activeModel: active.provider === providerId ? active.model : null,
    };

    this.runtimeCache.set(providerId, state);
    return state;
  }

  /** Get all providers that are currently available (configured + reachable). */
  getAvailable(): ProviderDefinition[] {
    return this.getConfigured().filter((d) => this.getState(d.id).available);
  }

  /** Get models for a specific provider. */
  getModels(providerId: string): string[] {
    return this.getState(providerId).models;
  }

  // ─── Discovery ────────────────────────────────────────────────

  /** Refresh models for a single provider. */
  async refreshModels(providerId: string): Promise<string[]> {
    invalidateModelCache();
    this.clearRuntimeCache(providerId);
    const result = await discoverModels(true);
    this.lastDiscovery = result.models;
    this.runtimeCache.clear();
    this.emit("models:refreshed", providerId);
    return this.getModels(providerId);
  }

  /** Refresh all provider models and state. */
  async refreshAll(): Promise<void> {
    invalidateModelCache();
    this.runtimeCache.clear();
    const result = await discoverModels(true);
    this.lastDiscovery = result.models;
    this.emit("models:refreshed", "*");
  }

  /** Get the raw discovery results from the last refresh. */
  getLastDiscovery(): DiscoveredModel[] {
    return [...this.lastDiscovery];
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private getConfigEntries(): ProviderConfigEntry[] {
    return readGlobalConfig()?.providers ?? [];
  }

  private clearRuntimeCache(providerId: string): void {
    this.runtimeCache.delete(providerId);
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: ProviderRegistry | null = null;

/** Get the global ProviderRegistry singleton. */
export function getProviderRegistry(): ProviderRegistry {
  if (!_instance) _instance = new ProviderRegistry();
  return _instance;
}

/** Reset the singleton (for tests). */
export function resetProviderRegistry(): void {
  _instance = null;
}
