/**
 * shell_exec — run shell commands with safety checks.
 * Wraps existing executeShell() from src/app/shell.ts.
 */

import { z } from "zod";
import { ok, err } from "neverthrow";
import type { ToolDefinition, ToolOutput } from "../types.js";

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /sudo\s+rm/,
  /mkfs\b/,
  /dd\s+if=/,
  /:\(\)\{\s*:\|:&\s*\};:/,   // fork bomb
  />\s*\/dev\/sd/,
  /chmod\s+-R\s+777\s+\//,
];

const inputSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  timeout: z.number().optional().default(30000).describe("Timeout in ms"),
  cwd: z.string().optional().describe("Working directory override"),
});

export function createShellExecTool(): ToolDefinition {
  return {
    name: "shell_exec",
    displayName: "Run Shell Command",
    description: "Execute a shell command in the project directory. Returns stdout, stderr, and exit code.",
    category: "shell",
    inputSchema,
    defaultPermission: "confirm",
    riskLevel: "dangerous",
    destructive: true,
    requiresNetwork: true,
    source: "built-in",
    execute: async (input, context) => {
      const { command, timeout, cwd } = input as z.infer<typeof inputSchema>;
      const start = Date.now();

      // Block dangerous commands
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
          return err({ type: "execution_failed", toolName: "shell_exec", cause: `Blocked dangerous command: ${command.slice(0, 50)}` });
        }
      }

      const workDir = cwd ?? context.workingDirectory;

      try {
        const { executeShell } = await import("../../app/shell.js");

        const chunks: string[] = [];
        const result = await executeShell(command, (chunk) => {
          chunks.push(chunk);
          context.onProgress?.(`Running: ${command.slice(0, 40)}...`);
        }, {
          cwd: workDir,
          timeout,
          signal: context.abortSignal,
        });

        const fullOutput = chunks.join("");
        const output: ToolOutput = {
          success: result.exitCode === 0,
          data: { exitCode: result.exitCode, stdout: fullOutput },
          summary: `Ran \`${command.slice(0, 60)}\` → exit ${result.exitCode} (${Date.now() - start}ms)`,
          fullOutput,
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "shell_exec", cause: String(e) });
      }
    },
  };
}
