/**
 * OS keychain backend — macOS Keychain, Linux secret-tool.
 * Uses shell commands, zero npm dependencies.
 * NEVER passes secrets as command-line arguments on Linux (stdin piping).
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Result, ok, err } from "neverthrow";
import type { CredentialBackend, CredentialKey, CredentialError } from "../types.js";
import { KEYCHAIN_SERVICE, keychainAccount } from "../types.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 5000;

export class KeychainBackend implements CredentialBackend {
  readonly name = "keychain";

  async isAvailable(): Promise<boolean> {
    try {
      if (process.platform === "darwin") {
        await execFileAsync("/usr/bin/security", ["help"], { timeout: TIMEOUT_MS });
        return true;
      }
      if (process.platform === "linux") {
        await execFileAsync("which", ["secret-tool"], { timeout: TIMEOUT_MS });
        return true;
      }
      // Windows: skip for v1 (use encrypted backend)
      return false;
    } catch {
      return false;
    }
  }

  async get(provider: string, key: CredentialKey): Promise<Result<string | null, CredentialError>> {
    const account = keychainAccount(provider, key);
    try {
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync(
          "/usr/bin/security",
          ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
          { timeout: TIMEOUT_MS },
        );
        return ok(stdout.trim() || null);
      }

      if (process.platform === "linux") {
        const { stdout } = await execFileAsync(
          "secret-tool",
          ["lookup", "service", KEYCHAIN_SERVICE, "account", account],
          { timeout: TIMEOUT_MS },
        );
        return ok(stdout.trim() || null);
      }

      return ok(null);
    } catch (e: unknown) {
      // macOS exit 44 = item not found
      if (isExecError(e) && e.code === 44) return ok(null);
      // Linux secret-tool returns empty on not found
      if (isExecError(e) && e.stderr === "" && e.stdout === "") return ok(null);
      return ok(null); // Treat errors as "not found" rather than blocking
    }
  }

  async set(provider: string, key: CredentialKey, value: string): Promise<Result<void, CredentialError>> {
    const account = keychainAccount(provider, key);
    try {
      if (process.platform === "darwin") {
        await execFileAsync(
          "/usr/bin/security",
          ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value, "-U"],
          { timeout: TIMEOUT_MS },
        );
        return ok(undefined);
      }

      if (process.platform === "linux") {
        // CRITICAL: pipe value via stdin, NOT as argument (visible in ps)
        await new Promise<void>((resolve, reject) => {
          const child = spawn("secret-tool", [
            "store", "--label", `OpenPawl: ${account}`,
            "service", KEYCHAIN_SERVICE,
            "account", account,
          ], { timeout: TIMEOUT_MS });

          child.stdin.write(value);
          child.stdin.end();

          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`secret-tool store exited with code ${code}`));
          });
          child.on("error", reject);
        });
        return ok(undefined);
      }

      return err({ type: "keychain_unavailable", os: process.platform, reason: "Unsupported platform" });
    } catch (e) {
      return err({ type: "backend_error", backend: "keychain", cause: String(e) });
    }
  }

  async delete(provider: string, key: CredentialKey): Promise<Result<void, CredentialError>> {
    const account = keychainAccount(provider, key);
    try {
      if (process.platform === "darwin") {
        await execFileAsync(
          "/usr/bin/security",
          ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
          { timeout: TIMEOUT_MS },
        );
      } else if (process.platform === "linux") {
        await execFileAsync(
          "secret-tool",
          ["clear", "service", KEYCHAIN_SERVICE, "account", account],
          { timeout: TIMEOUT_MS },
        );
      }
      return ok(undefined);
    } catch {
      return ok(undefined); // Delete is idempotent
    }
  }

  async list(): Promise<Result<Array<{ provider: string; key: CredentialKey }>, CredentialError>> {
    // Keychain listing is platform-specific and unreliable.
    // Return empty — the credential store maintains its own index.
    return ok([]);
  }

  async clear(): Promise<Result<void, CredentialError>> {
    // Not easily implementable without a full list. No-op.
    return ok(undefined);
  }
}

function isExecError(e: unknown): e is { code: number; stdout: string; stderr: string } {
  return typeof e === "object" && e !== null && "code" in e;
}
