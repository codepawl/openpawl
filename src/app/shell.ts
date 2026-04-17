/**
 * Shell command executor for !command syntax and shell_exec tool.
 * Streams output to a callback for real-time display, and returns
 * separated stdout/stderr buffers so callers can classify failures
 * without regexing merged output.
 */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecuteShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function executeShell(
  command: string,
  onOutput: (chunk: string) => void,
  options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
): Promise<ExecuteShellResult> {
  const cwd = options?.cwd ?? process.cwd();
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

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
      const chunk = data.toString();
      stdout += chunk;
      onOutput(chunk);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      onOutput(chunk);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        onOutput(`\n[exit code: ${code}]\n`);
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      onOutput(`\n[error: ${err.message}]\n`);
      resolve({ exitCode: 1, stdout, stderr: stderr + err.message });
    });
  });
}
