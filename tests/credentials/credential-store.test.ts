import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import { EncryptedBackend } from "../../src/credentials/backends/encrypted-backend.js";

describe("CredentialStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-cred-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createStoreWithEncrypted(): CredentialStore {
    const store = new CredentialStore();
    (store as any).backend = new EncryptedBackend(tmpDir);
    (store as any).initialized = true;
    return store;
  }

  it("getBackendName returns correct backend", () => {
    const store = createStoreWithEncrypted();
    expect(store.getBackendName()).toBe("encrypted");
  });

  it("resolveApiKey: env var takes precedence", async () => {
    const store = createStoreWithEncrypted();
    await store.setCredential("anthropic", "apiKey", "stored-key");

    process.env.ANTHROPIC_API_KEY = "env-key";
    const result = await store.resolveApiKey("anthropic");
    expect(result).toBe("env-key");
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("resolveApiKey: store value when no env var", async () => {
    const store = createStoreWithEncrypted();
    const origEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    await store.setCredential("anthropic", "apiKey", "stored-key");
    const result = await store.resolveApiKey("anthropic");
    expect(result).toBe("stored-key");

    if (origEnv) process.env.ANTHROPIC_API_KEY = origEnv;
  });

  it("resolveApiKey: returns null when nothing configured", async () => {
    const store = createStoreWithEncrypted();
    const origEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const result = await store.resolveApiKey("anthropic");
    expect(result).toBeNull();

    if (origEnv) process.env.ANTHROPIC_API_KEY = origEnv;
  });

  it("listCredentials returns entries from active backend", async () => {
    const store = createStoreWithEncrypted();
    await store.setCredential("a", "apiKey", "val-a");
    await store.setCredential("b", "apiKey", "val-b");

    const result = await store.listCredentials();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().length).toBe(2);
    expect(result._unsafeUnwrap()[0]!.backend).toBe("encrypted");
  });

  it("clearAll removes all credentials", async () => {
    const store = createStoreWithEncrypted();
    await store.setCredential("a", "apiKey", "val");
    await store.clearAll();

    const result = await store.getCredential("a", "apiKey");
    expect(result._unsafeUnwrap()).toBeNull();
  });
});
