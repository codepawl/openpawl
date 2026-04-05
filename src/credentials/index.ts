/**
 * Credential storage — secure API key management.
 */

export type {
  StoredCredential,
  CredentialKey,
  CredentialBackend,
  CredentialError,
} from "./types.js";

export { KEYCHAIN_SERVICE, keychainAccount } from "./types.js";
export { CredentialStore } from "./credential-store.js";
export { KeychainBackend } from "./backends/keychain-backend.js";
export { EncryptedBackend } from "./backends/encrypted-backend.js";
export { deriveEncryptionKey } from "./key-derivation.js";
export { maskCredential, looksLikeCredential, redactCredentials } from "./masking.js";
export { migrateCredentials, hasPlaintextCredentials } from "./migration.js";
export type { MigrationResult } from "./migration.js";
