/**
 * CredentialStore — facade over keychain + encrypted backends.
 * Selects best available backend, provides unified API.
 */

import { Result, ok, err } from "neverthrow";
import type { CredentialBackend, CredentialKey, CredentialError } from "./types.js";
import { KeychainBackend } from "./backends/keychain-backend.js";
import { EncryptedBackend } from "./backends/encrypted-backend.js";

// Env var → provider mapping
const ENV_KEY_MAP: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  DEEPSEEK_API_KEY: "deepseek",
  GROQ_API_KEY: "groq",
  GOOGLE_API_KEY: "gemini",
  XAI_API_KEY: "grok",
  MISTRAL_API_KEY: "mistral",
};

const PROVIDER_ENV_MAP: Record<string, string> = {};
for (const [env, provider] of Object.entries(ENV_KEY_MAP)) {
  PROVIDER_ENV_MAP[provider] = env;
}

export class CredentialStore {
  private backend: CredentialBackend | null = null;
  private initialized = false;

  async initialize(): Promise<Result<void, CredentialError>> {
    try {
      const keychain = new KeychainBackend();
      if (await keychain.isAvailable()) {
        this.backend = keychain;
        this.initialized = true;
        return ok(undefined);
      }

      this.backend = new EncryptedBackend();
      this.initialized = true;
      return ok(undefined);
    } catch (e) {
      return err({ type: "backend_error", backend: "init", cause: String(e) });
    }
  }

  getBackendName(): string {
    return this.backend?.name ?? "none";
  }

  async getCredential(provider: string, key: CredentialKey): Promise<Result<string | null, CredentialError>> {
    if (!this.backend) return ok(null);
    return this.backend.get(provider, key);
  }

  async setCredential(provider: string, key: CredentialKey, value: string): Promise<Result<void, CredentialError>> {
    if (!this.backend) return err({ type: "backend_error", backend: "none", cause: "Not initialized" });
    return this.backend.set(provider, key, value);
  }

  async deleteCredential(provider: string, key: CredentialKey): Promise<Result<void, CredentialError>> {
    if (!this.backend) return ok(undefined);
    return this.backend.delete(provider, key);
  }

  async listCredentials(): Promise<Result<Array<{ provider: string; key: CredentialKey; backend: string }>, CredentialError>> {
    if (!this.backend) return ok([]);
    const result = await this.backend.list();
    if (result.isErr()) return err(result.error);
    return ok(result.value.map((e) => ({ ...e, backend: this.backend!.name })));
  }

  async clearAll(): Promise<Result<void, CredentialError>> {
    if (!this.backend) return ok(undefined);
    return this.backend.clear();
  }

  /** Resolve API key: env var → secure store → config (legacy). */
  async resolveApiKey(provider: string): Promise<string | null> {
    // 1. Check environment variable
    const envVar = PROVIDER_ENV_MAP[provider];
    if (envVar && process.env[envVar]) {
      return process.env[envVar]!;
    }

    // 2. Check secure store
    if (this.backend) {
      const result = await this.backend.get(provider, "apiKey");
      if (result.isOk() && result.value) return result.value;
    }

    return null;
  }

  /** Get all credentials for a provider. */
  async getProviderCredentials(provider: string): Promise<Record<CredentialKey, string | null>> {
    const keys: CredentialKey[] = ["apiKey", "oauthToken", "refreshToken", "setupToken"];
    const result: Record<string, string | null> = {};
    for (const key of keys) {
      const r = await this.getCredential(provider, key);
      result[key] = r.isOk() ? r.value : null;
    }
    return result as Record<CredentialKey, string | null>;
  }
}
