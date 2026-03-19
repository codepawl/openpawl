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
import { CopilotProvider } from "./copilot-provider.js";
import { ChatGPTOAuthProvider } from "./chatgpt-oauth-provider.js";
import { BedrockProvider } from "./bedrock-provider.js";
import { VertexProvider } from "./vertex-provider.js";
import type { StreamProvider } from "./provider.js";
import { readGlobalConfig, type ProviderConfigEntry } from "../core/global-config.js";
import { logger } from "../core/logger.js";
import { setActiveProviderFamily } from "../core/model-config.js";

let globalManager: ProviderManager | null = null;

const ENV_KEY_MAP: Record<string, OpenAIPreset> = {
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  DEEPSEEK_API_KEY: "deepseek",
  GROQ_API_KEY: "groq",
  GOOGLE_API_KEY: "gemini",
  GEMINI_API_KEY: "gemini",
  XAI_API_KEY: "grok",
  MISTRAL_API_KEY: "mistral",
  CEREBRAS_API_KEY: "cerebras",
  TOGETHER_API_KEY: "together",
  TOGETHER_AI_API_KEY: "together",
  FIREWORKS_API_KEY: "fireworks",
  PERPLEXITY_API_KEY: "perplexity",
  MOONSHOT_API_KEY: "moonshot",
  ZAI_API_KEY: "zai",
  ZHIPU_API_KEY: "zai",
  MINIMAX_API_KEY: "minimax",
  COHERE_API_KEY: "cohere",
  OPENCODE_API_KEY: "opencode-zen",
  OPENCODE_GO_API_KEY: "opencode-go",
  AZURE_OPENAI_API_KEY: "azure",
};

/** Types that use the Anthropic native SDK */
const ANTHROPIC_TYPES = new Set(["anthropic", "anthropic-sub"]);

function providerFromConfig(entry: ProviderConfigEntry): StreamProvider | null {
  // Anthropic native SDK
  if (ANTHROPIC_TYPES.has(entry.type)) {
    return new AnthropicProvider({
      apiKey: entry.apiKey ?? entry.setupToken,
      model: entry.model,
    });
  }

  // Dedicated providers
  switch (entry.type) {
    case "chatgpt":
      return new ChatGPTOAuthProvider({
        oauthToken: entry.oauthToken,
        refreshToken: entry.refreshToken,
        tokenExpiry: entry.tokenExpiry,
        model: entry.model,
      });

    case "copilot":
      return new CopilotProvider({
        githubToken: entry.githubToken,
        copilotToken: entry.copilotToken,
        copilotTokenExpiry: entry.copilotTokenExpiry,
        model: entry.model,
      });

    case "bedrock":
      return new BedrockProvider({
        accessKeyId: entry.accessKeyId,
        secretAccessKey: entry.secretAccessKey,
        sessionToken: entry.sessionToken,
        region: entry.region,
        model: entry.model,
      });

    case "vertex":
      return new VertexProvider({
        serviceAccountPath: entry.serviceAccountPath,
        projectId: entry.projectId,
        region: entry.region,
        model: entry.model,
      });

    case "gemini-oauth":
      logger.warn('Gemini OAuth not yet implemented. Use API key: teamclaw providers add gemini');
      return null;
  }

  // Everything else uses OpenAI-compatible
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
  const seenPresets = new Set<string>();

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }

  for (const [envKey, preset] of Object.entries(ENV_KEY_MAP)) {
    if (process.env[envKey] && !seenPresets.has(preset)) {
      seenPresets.add(preset);
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
    return configEntries
      .map(providerFromConfig)
      .filter((p): p is StreamProvider => p !== null);
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

  // Set active provider family for tier-based model routing
  const first = chain[0];
  if (first) {
    const family = first.name === "anthropic" ? "anthropic" as const
      : (first.name === "openai" || first.name === "chatgpt") ? "openai" as const
      : "generic" as const;
    setActiveProviderFamily(family);
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
