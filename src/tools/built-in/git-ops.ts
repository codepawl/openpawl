/**
 * git_ops — safe git operations (no push/pull/remote/reset --hard).
 */

import { z } from "zod";
import { ok, err } from "neverthrow";
import type { ToolDefinition, ToolOutput } from "../types.js";

const BLOCKED_OPERATIONS = new Set(["push", "pull", "remote", "fetch"]);
const BLOCKED_ARGS_PATTERNS = [/reset\s+--hard/, /clean\s+-f/, /branch\s+-D/];

const inputSchema = z.object({
  operation: z.enum(["status", "diff", "add", "commit", "log", "branch", "checkout", "stash"]),
  args: z.string().optional().describe("Additional arguments"),
  message: z.string().optional().describe("Commit message (for commit operation)"),
  files: z.array(z.string()).optional().describe("File paths (for add operation)"),
});

export function createGitOpsTool(): ToolDefinition {
  return {
    name: "git_ops",
    displayName: "Git Operations",
    description: "Perform git operations: status, diff, add, commit, log, branch, checkout, stash.",
    category: "git",
    inputSchema,
    defaultPermission: "session",
    riskLevel: "moderate",
    destructive: true,
    requiresNetwork: false,
    source: "built-in",
    execute: async (input, context) => {
      const { operation, args, message, files } = input as z.infer<typeof inputSchema>;
      const start = Date.now();

      // Block dangerous operations
      if (BLOCKED_OPERATIONS.has(operation)) {
        return err({ type: "execution_failed", toolName: "git_ops", cause: `Operation "${operation}" is not allowed for safety` });
      }

      const fullArgs = args ?? "";
      for (const pattern of BLOCKED_ARGS_PATTERNS) {
        if (pattern.test(`${operation} ${fullArgs}`)) {
          return err({ type: "execution_failed", toolName: "git_ops", cause: `Blocked dangerous git command: git ${operation} ${fullArgs}` });
        }
      }

      // Build command
      let command = `git ${operation}`;
      if (operation === "commit") {
        if (!message) {
          return err({ type: "validation_failed", toolName: "git_ops", errors: ["Commit message is required"] });
        }
        const safeMsg = `[openpawl] ${message}`.replace(/'/g, "'\\''");
        command = `git commit -m '${safeMsg}'`;
      } else if (operation === "add" && files?.length) {
        const safeFiles = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
        command = `git add ${safeFiles}`;
      } else if (fullArgs) {
        command += ` ${fullArgs}`;
      }

      try {
        const { executeShell } = await import("../../app/shell.js");
        const chunks: string[] = [];
        const result = await executeShell(command, (chunk) => chunks.push(chunk), {
          cwd: context.workingDirectory,
          timeout: 15_000,
          signal: context.abortSignal,
        });

        const fullOutput = chunks.join("");
        const output: ToolOutput = {
          success: result.exitCode === 0,
          data: { exitCode: result.exitCode, output: fullOutput },
          summary: `git ${operation} → exit ${result.exitCode}`,
          fullOutput,
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "git_ops", cause: String(e) });
      }
    },
  };
}
