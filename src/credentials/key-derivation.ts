/**
 * Derive encryption key from machine-specific data.
 * Uses PBKDF2 with 100k iterations for key stretching.
 * NOT password-level security — machine-binding only.
 */

import { pbkdf2 } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";

const pbkdf2Async = promisify(pbkdf2);
const SALT = "openpawl-credential-store-v1";
const ITERATIONS = 100_000;

export async function deriveEncryptionKey(): Promise<Buffer> {
  const machineId = await getMachineId();
  const username = os.userInfo().username;
  const material = `${machineId}:${username}:${SALT}`;

  return pbkdf2Async(material, SALT, ITERATIONS, 32, "sha256");
}

async function getMachineId(): Promise<string> {
  // Linux: read machine-id file
  if (process.platform === "linux") {
    for (const filePath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        if (existsSync(filePath)) {
          const id = (await readFile(filePath, "utf-8")).trim();
          if (id) return id;
        }
      } catch {
        // Continue to fallback
      }
    }
  }

  // Fallback for all platforms: hostname + username + arch
  return `${os.hostname()}:${os.userInfo().username}:${os.arch()}`;
}
