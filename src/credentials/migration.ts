/**
 * Migrate plaintext credentials from config to secure storage.
 */

import { Result, ok } from "neverthrow";
import type { CredentialKey, CredentialError } from "./types.js";
import type { CredentialStore } from "./credential-store.js";

export interface MigrationResult {
  migrated: Array<{ provider: string; key: CredentialKey }>;
  skipped: Array<{ provider: string; key: CredentialKey; reason: string }>;
  failed: Array<{ provider: string; key: CredentialKey; error: string }>;
}

const CREDENTIAL_FIELDS: CredentialKey[] = ["apiKey", "oauthToken", "refreshToken", "setupToken"];

/** Check if config has any plaintext credentials that should be migrated. */
export function hasPlaintextCredentials(config: Record<string, unknown>): boolean {
  const providers = config.providers as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(providers)) return false;

  for (const provider of providers) {
    if (provider.credentialStore === true) continue;
    for (const field of CREDENTIAL_FIELDS) {
      if (typeof provider[field] === "string" && provider[field]) return true;
    }
  }
  return false;
}

/** Migrate plaintext credentials from config to secure store. */
export async function migrateCredentials(
  config: Record<string, unknown>,
  store: CredentialStore,
): Promise<Result<MigrationResult, CredentialError>> {
  const result: MigrationResult = { migrated: [], skipped: [], failed: [] };

  const providers = config.providers as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(providers)) return ok(result);

  for (const provider of providers) {
    const providerName = provider.type as string;
    if (!providerName) continue;

    // Already migrated
    if (provider.credentialStore === true) {
      result.skipped.push({ provider: providerName, key: "apiKey", reason: "already migrated" });
      continue;
    }

    for (const field of CREDENTIAL_FIELDS) {
      const value = provider[field] as string | undefined;
      if (!value) continue;

      // Store in secure backend
      const storeResult = await store.setCredential(providerName, field, value);
      if (storeResult.isOk()) {
        // Remove plaintext from config
        delete provider[field];
        provider.credentialStore = true;
        result.migrated.push({ provider: providerName, key: field });
      } else {
        // SAFETY: don't delete from config if store failed
        result.failed.push({
          provider: providerName,
          key: field,
          error: storeResult.error.type,
        });
      }
    }
  }

  return ok(result);
}
