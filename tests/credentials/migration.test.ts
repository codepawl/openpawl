import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hasPlaintextCredentials, migrateCredentials } from "../../src/credentials/migration.js";
import { CredentialStore } from "../../src/credentials/credential-store.js";

describe("migration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-mig-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("hasPlaintextCredentials", () => {
    it("detects apiKey in config", () => {
      const config = { providers: [{ type: "anthropic", apiKey: "sk-test" }] };
      expect(hasPlaintextCredentials(config)).toBe(true);
    });

    it("returns false when all migrated", () => {
      const config = { providers: [{ type: "anthropic", credentialStore: true }] };
      expect(hasPlaintextCredentials(config)).toBe(false);
    });

    it("returns false for empty providers", () => {
      expect(hasPlaintextCredentials({ providers: [] })).toBe(false);
      expect(hasPlaintextCredentials({})).toBe(false);
    });
  });

  describe("migrateCredentials", () => {
    it("migrates plaintext apiKey to credential store", async () => {
      // Use encrypted backend (always available)
      const store = new CredentialStore();
      // Force encrypted backend by not calling initialize (which tries keychain)
      (store as any).backend = new (await import("../../src/credentials/backends/encrypted-backend.js")).EncryptedBackend(tmpDir);
      (store as any).initialized = true;

      const config = { providers: [{ type: "anthropic", apiKey: "sk-test-key" }] };
      const result = await migrateCredentials(config, store);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().migrated).toHaveLength(1);
      expect(result._unsafeUnwrap().migrated[0]!.provider).toBe("anthropic");
    });

    it("removes apiKey from config after migration", async () => {
      const store = new CredentialStore();
      (store as any).backend = new (await import("../../src/credentials/backends/encrypted-backend.js")).EncryptedBackend(tmpDir);
      (store as any).initialized = true;

      const config = { providers: [{ type: "openai", apiKey: "sk-test" }] };
      await migrateCredentials(config, store);

      expect((config.providers[0] as any).apiKey).toBeUndefined();
      expect((config.providers[0] as any).credentialStore).toBe(true);
    });

    it("skips providers with credentialStore: true", async () => {
      const store = new CredentialStore();
      (store as any).backend = new (await import("../../src/credentials/backends/encrypted-backend.js")).EncryptedBackend(tmpDir);
      (store as any).initialized = true;

      const config = { providers: [{ type: "anthropic", credentialStore: true }] };
      const result = await migrateCredentials(config, store);

      expect(result._unsafeUnwrap().skipped).toHaveLength(1);
      expect(result._unsafeUnwrap().migrated).toHaveLength(0);
    });
  });
});
