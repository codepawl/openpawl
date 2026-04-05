/**
 * Encrypted file backend — AES-256-GCM with machine-derived key.
 * Fallback when OS keychain is unavailable.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Result, ok, err } from "neverthrow";
import type { CredentialBackend, CredentialKey, CredentialError } from "../types.js";
import { deriveEncryptionKey } from "../key-derivation.js";

interface EncryptedEntry {
  iv: string;        // base64
  ciphertext: string; // base64
  authTag: string;   // base64
  storedAt: string;
}

interface EncryptedFile {
  version: number;
  entries: Record<string, EncryptedEntry>;
}

export class EncryptedBackend implements CredentialBackend {
  readonly name = "encrypted";
  private filePath: string;
  private keyPromise: Promise<Buffer> | null = null;

  constructor(configDir?: string) {
    const dir = configDir ?? path.join(os.homedir(), ".openpawl");
    this.filePath = path.join(dir, ".credentials.enc");
  }

  async isAvailable(): Promise<boolean> {
    return true; // Pure Node.js crypto — always available
  }

  async get(provider: string, key: CredentialKey): Promise<Result<string | null, CredentialError>> {
    try {
      const file = await this.readEncryptedFile();
      const account = `${provider}:${key}`;
      const entry = file.entries[account];
      if (!entry) return ok(null);

      const encKey = await this.getKey();
      const iv = Buffer.from(entry.iv, "base64");
      const ciphertext = Buffer.from(entry.ciphertext, "base64");
      const authTag = Buffer.from(entry.authTag, "base64");

      const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      return ok(decrypted.toString("utf-8"));
    } catch (e) {
      if (!existsSync(this.filePath)) return ok(null);
      return err({ type: "decryption_failed", cause: String(e) });
    }
  }

  async set(provider: string, key: CredentialKey, value: string): Promise<Result<void, CredentialError>> {
    try {
      const file = await this.readEncryptedFile();
      const account = `${provider}:${key}`;
      const encKey = await this.getKey();

      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encKey, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      file.entries[account] = {
        iv: iv.toString("base64"),
        ciphertext: encrypted.toString("base64"),
        authTag: authTag.toString("base64"),
        storedAt: new Date().toISOString(),
      };

      await this.writeEncryptedFile(file);
      return ok(undefined);
    } catch (e) {
      return err({ type: "encryption_failed", cause: String(e) });
    }
  }

  async delete(provider: string, key: CredentialKey): Promise<Result<void, CredentialError>> {
    try {
      const file = await this.readEncryptedFile();
      const account = `${provider}:${key}`;
      delete file.entries[account];
      await this.writeEncryptedFile(file);
      return ok(undefined);
    } catch (e) {
      return err({ type: "backend_error", backend: "encrypted", cause: String(e) });
    }
  }

  async list(): Promise<Result<Array<{ provider: string; key: CredentialKey }>, CredentialError>> {
    try {
      const file = await this.readEncryptedFile();
      return ok(
        Object.keys(file.entries).map((account) => {
          const [provider, key] = account.split(":");
          return { provider: provider!, key: key! as CredentialKey };
        }),
      );
    } catch {
      return ok([]);
    }
  }

  async clear(): Promise<Result<void, CredentialError>> {
    try {
      await this.writeEncryptedFile({ version: 1, entries: {} });
      return ok(undefined);
    } catch (e) {
      return err({ type: "backend_error", backend: "encrypted", cause: String(e) });
    }
  }

  private async getKey(): Promise<Buffer> {
    if (!this.keyPromise) {
      this.keyPromise = deriveEncryptionKey();
    }
    return this.keyPromise;
  }

  private async readEncryptedFile(): Promise<EncryptedFile> {
    if (!existsSync(this.filePath)) {
      return { version: 1, entries: {} };
    }
    const raw = await readFile(this.filePath, "utf-8");
    return JSON.parse(raw) as EncryptedFile;
  }

  private async writeEncryptedFile(file: EncryptedFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const tmpPath = this.filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(file, null, 2), { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }
}
