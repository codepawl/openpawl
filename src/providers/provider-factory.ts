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
import { type ProviderConfigEntry } from "../core/global-config.js";
import { listProviders as getConfigProviders } from "../core/provider-config.js";
import { logger } from "../core/logger.js";
import { setActiveProviderFamily } from "../core/model-config.js";
import { CredentialStore } from "../credentials/credential-store.js";
import { detectProviders } from "./detect.js";

let globalManager: ProviderManager | null = null;

export async function providerFromConfig(entry: ProviderConfigEntry): Promise<StreamProvider | null> {
  // Resolve API key from credential store if not provided inline
  let resolvedApiKey = entry.apiKey;
  if (!resolvedApiKey && entry.hasCredential) {
    const store = new CredentialStore();
    await store.initialize();
    resolvedApiKey = await store.resolveApiKey(entry.type) ?? undefined;
  }

  // Anthropic native SDK
  if (entry.type === "anthropic") {
    return new AnthropicProvider({
      apiKey: resolvedApiKey,
      model: entry.model,
    });
  }

  // Dedicated providers
  switch (entry.type) {
    case "chatgpt": {
      let oauthToken = entry.oauthToken;
      let refreshToken = entry.refreshToken;
      if (!oauthToken && entry.hasCredential) {
        const store = new CredentialStore();
        await store.initialize();
        const cred = await store.getCredential("chatgpt", "oauthToken");
        if (cred.isOk() && cred.value) oauthToken = cred.value;
        const ref = await store.getCredential("chatgpt", "refreshToken");
        if (ref.isOk() && ref.value) refreshToken = ref.value;
      }
      return new ChatGPTOAuthProvider({
        oauthToken,
        refreshToken,
        tokenExpiry: entry.tokenExpiry,
        model: entry.model,
      });
    }

    case "copilot": {
      let githubToken = entry.githubToken;
      if (!githubToken && entry.hasCredential) {
        const store = new CredentialStore();
        await store.initialize();
        const cred = await store.getCredential("copilot", "oauthToken");
        if (cred.isOk() && cred.value) githubToken = cred.value;
      }
      // Also check GITHUB_TOKEN env var
      if (!githubToken) githubToken = process.env.GITHUB_TOKEN;
      return new CopilotProvider({
        githubToken,
        copilotToken: entry.copilotToken,
        copilotTokenExpiry: entry.copilotTokenExpiry,
        model: entry.model,
      });
    }

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
      logger.warn('Gemini OAuth not yet implemented. Use API key: openpawl providers add gemini');
      return null;
  }

  // Everything else uses OpenAI-compatible
  return new OpenAICompatibleProvider({
    preset: entry.type as OpenAIPreset,
    apiKey: resolvedApiKey,
    baseURL: entry.baseURL,
    model: entry.model,
    name: entry.name,
  });
}

export async function discoverFromEnv(): Promise<StreamProvider[]> {
  const detected = await detectProviders();
  const providers: StreamProvider[] = [];
  for (const d of detected.filter((p) => p.available && p.source === "env")) {
    const entry: ProviderConfigEntry = { type: d.type as ProviderConfigEntry["type"] };
    const provider = await providerFromConfig(entry);
    if (provider) providers.push(provider);
  }
  return providers;
}

export async function createProviderChain(
  configEntries?: ProviderConfigEntry[],
): Promise<StreamProvider[]> {
  if (configEntries && configEntries.length > 0) {
    const settled = await Promise.all(configEntries.map(providerFromConfig));
    return settled.filter((p): p is StreamProvider => p !== null);
  }

  const fromEnv = await discoverFromEnv();
  if (fromEnv.length > 0) return fromEnv;

  return [];
}

export async function getGlobalProviderManager(): Promise<ProviderManager> {
  if (globalManager) return globalManager;

  let configProviders: ProviderConfigEntry[] | undefined;
  try {
    const providers = getConfigProviders();
    configProviders = providers.length > 0 ? providers : undefined;
  } catch {
    // Config unavailable — rely on env vars
  }

  const chain = await createProviderChain(configProviders);
  if (chain.length === 0) {
    logger.warn("No LLM providers configured. Set an API key env var or run `openpawl setup`.");
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
