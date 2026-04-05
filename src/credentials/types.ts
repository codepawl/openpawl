/**
 * Credential storage types and errors.
 */

import type { Result } from "neverthrow";

export type CredentialKey = "apiKey" | "oauthToken" | "refreshToken" | "setupToken";

export interface StoredCredential {
  provider: string;
  key: CredentialKey;
  value: string;
  storedAt: string;
  backend: "keychain" | "encrypted";
}

export interface CredentialBackend {
  name: string;
  isAvailable(): Promise<boolean>;
  get(provider: string, key: CredentialKey): Promise<Result<string | null, CredentialError>>;
  set(provider: string, key: CredentialKey, value: string): Promise<Result<void, CredentialError>>;
  delete(provider: string, key: CredentialKey): Promise<Result<void, CredentialError>>;
  list(): Promise<Result<Array<{ provider: string; key: CredentialKey }>, CredentialError>>;
  clear(): Promise<Result<void, CredentialError>>;
}

export type CredentialError =
  | { type: "keychain_unavailable"; os: string; reason: string }
  | { type: "keychain_access_denied"; reason: string }
  | { type: "encryption_failed"; cause: string }
  | { type: "decryption_failed"; cause: string }
  | { type: "credential_not_found"; provider: string; key: CredentialKey }
  | { type: "backend_error"; backend: string; cause: string }
  | { type: "migration_failed"; cause: string }
  | { type: "invalid_credential"; provider: string; reason: string };

export const KEYCHAIN_SERVICE = "openpawl";

export function keychainAccount(provider: string, key: CredentialKey): string {
  return `${provider}:${key}`;
}
