/**
 * Global provider singleton — resolves provider chain from config + env vars.
 *
 * Resolution order:
 *   1. Explicit `providers` array in global config
 *   2. Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 *   3. Empty chain (warn)
 */

import { ProviderManager } from "./provider-manager.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider, type OpenAIPreset } from "./openai-compatible-provider.js";
import type { StreamProvider } from "./provider.js";
import { readGlobalConfig, type ProviderConfigEntry } from "../core/global-config.js";
import { logger } from "../core/logger.js";

let globalManager: ProviderManager | null = null;

const ENV_KEY_MAP: Record<string, OpenAIPreset> = {
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  DEEPSEEK_API_KEY: "deepseek",
  GROQ_API_KEY: "groq",
};

function providerFromConfig(entry: ProviderConfigEntry): StreamProvider {
  if (entry.type === "anthropic") {
    return new AnthropicProvider({
      apiKey: entry.apiKey,
      model: entry.model,
    });
  }
  return new OpenAICompatibleProvider({
    preset: entry.type as OpenAIPreset,
    apiKey: entry.apiKey,
    baseURL: entry.baseURL,
    model: entry.model,
    name: entry.name,
  });
}

function discoverFromEnv(): StreamProvider[] {
  const providers: StreamProvider[] = [];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }

  for (const [envKey, preset] of Object.entries(ENV_KEY_MAP)) {
    if (process.env[envKey]) {
      providers.push(
        new OpenAICompatibleProvider({
          preset,
          apiKey: process.env[envKey],
        }),
      );
    }
  }

  return providers;
}

export function createProviderChain(
  configEntries?: ProviderConfigEntry[],
): StreamProvider[] {
  if (configEntries && configEntries.length > 0) {
    return configEntries.map(providerFromConfig);
  }

  const fromEnv = discoverFromEnv();
  if (fromEnv.length > 0) return fromEnv;

  return [];
}

export function getGlobalProviderManager(): ProviderManager {
  if (globalManager) return globalManager;

  let configProviders: ProviderConfigEntry[] | undefined;
  try {
    const cfg = readGlobalConfig();
    configProviders = cfg?.providers;
  } catch {
    // Config unavailable — rely on env vars
  }

  const chain = createProviderChain(configProviders);
  if (chain.length === 0) {
    logger.warn("No LLM providers configured. Set an API key env var or run `teamclaw setup`.");
  }

  globalManager = new ProviderManager(chain);
  return globalManager;
}

export function setGlobalProviderManager(manager: ProviderManager): void {
  globalManager = manager;
}

export function resetGlobalProviderManager(): void {
  globalManager = null;
}
