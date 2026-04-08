import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EncryptedBackend } from "../../src/credentials/backends/encrypted-backend.js";

describe("EncryptedBackend", () => {
  let tmpDir: string;
  let backend: EncryptedBackend;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-enc-test-"));
    backend = new EncryptedBackend(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("isAvailable always returns true", async () => {
    expect(await backend.isAvailable()).toBe(true);
  });

  it("set encrypts and writes to file", async () => {
    const result = await backend.set("anthropic", "apiKey", "sk-test-secret-key");
    expect(result.isOk()).toBe(true);
    expect(existsSync(path.join(tmpDir, ".credentials.enc"))).toBe(true);
  });

  it("get decrypts and returns correct value", async () => {
    await backend.set("anthropic", "apiKey", "my-secret-key-123");
    const result = await backend.get("anthropic", "apiKey");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("my-secret-key-123");
  });

  it("get returns null for non-existent entry", async () => {
    const result = await backend.get("nonexistent", "apiKey");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("delete removes entry from file", async () => {
    await backend.set("anthropic", "apiKey", "key-to-delete");
    await backend.delete("anthropic", "apiKey");
    const result = await backend.get("anthropic", "apiKey");
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("file has correct permissions (0o600)", async () => {
    if (process.platform === "win32") return;
    await backend.set("test", "apiKey", "value");
    const stats = await stat(path.join(tmpDir, ".credentials.enc"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("round-trip: set → get returns same value", async () => {
    const testValues = [
      "sk-ant-api03-very-long-key-with-special-chars-!@#$%",
      "short",
      "a".repeat(1000),
    ];
    for (const value of testValues) {
      await backend.set("test", "apiKey", value);
      const result = await backend.get("test", "apiKey");
      expect(result._unsafeUnwrap()).toBe(value);
    }
  });

  it("multiple entries coexist in same file", async () => {
    await backend.set("anthropic", "apiKey", "key-a");
    await backend.set("openai", "apiKey", "key-b");
    await backend.set("groq", "apiKey", "key-c");

    expect((await backend.get("anthropic", "apiKey"))._unsafeUnwrap()).toBe("key-a");
    expect((await backend.get("openai", "apiKey"))._unsafeUnwrap()).toBe("key-b");
    expect((await backend.get("groq", "apiKey"))._unsafeUnwrap()).toBe("key-c");
  });

  it("clear removes all entries", async () => {
    await backend.set("a", "apiKey", "val-a");
    await backend.set("b", "apiKey", "val-b");
    await backend.clear();

    expect((await backend.get("a", "apiKey"))._unsafeUnwrap()).toBeNull();
    expect((await backend.get("b", "apiKey"))._unsafeUnwrap()).toBeNull();
  });

  it("list returns stored entries", async () => {
    await backend.set("anthropic", "apiKey", "key");
    await backend.set("openai", "oauthToken", "token");

    const result = await backend.list();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });
});
