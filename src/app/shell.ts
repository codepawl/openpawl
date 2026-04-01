/**
 * Shell command executor for !command syntax.
 * Streams output to a callback for real-time display.
 */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export async function executeShell(
  command: string,
  onOutput: (chunk: string) => void,
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
): Promise<{ exitCode: number }> {
  const cwd = options?.cwd ?? process.cwd();
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      onOutput("\n[timed out after " + (timeout / 1000) + "s]\n");
    }, timeout);

    if (options?.signal) {
      options.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      }, { once: true });
    }

    child.stdout?.on("data", (data: Buffer) => {
      onOutput(data.toString());
    });

    child.stderr?.on("data", (data: Buffer) => {
      onOutput(data.toString());
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        onOutput(`\n[exit code: ${code}]\n`);
      }
      resolve({ exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      onOutput(`\n[error: ${err.message}]\n`);
      resolve({ exitCode: 1 });
    });
  });
}
