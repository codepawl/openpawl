/**
 * execute_code — wraps existing secure-exec V8 sandbox.
 * Does NOT rewrite code-executor.ts — just adapts the interface.
 */

import { z } from "zod";
import { ok, err } from "neverthrow";
import type { ToolDefinition, ToolOutput } from "../types.js";

const inputSchema = z.object({
  code: z.string().describe("JavaScript/TypeScript code to execute"),
  language: z.enum(["javascript", "typescript"]).optional().default("javascript"),
});

export function createExecuteCodeTool(): ToolDefinition {
  return {
    name: "execute_code",
    displayName: "Execute Code",
    description: "Run JavaScript/TypeScript code in a sandboxed V8 isolate. " +
      "No network access. Read/write limited to workspace. Exit code 124 = CPU timeout (>15s).",
    category: "code",
    inputSchema,
    defaultPermission: "session",
    riskLevel: "dangerous",
    destructive: false,
    requiresNetwork: false,
    source: "built-in",
    execute: async (input, context) => {
      const { code } = input as z.infer<typeof inputSchema>;
      const start = Date.now();

      try {
        const { createCodeExecutorTool } = await import("../code-executor.js");
        const executor = createCodeExecutorTool(context.workingDirectory);
        const result = await executor.execute({ code });

        const output: ToolOutput = {
          success: result.success,
          data: {
            exitCode: result.exitCode,
            output: result.output,
            error: result.error,
          },
          summary: result.success
            ? `Code executed successfully (${result.durationMs}ms)\n${result.output.slice(0, 200)}`
            : `Code execution failed: ${result.error ?? "unknown error"}`,
          fullOutput: result.output + (result.error ? `\nError: ${result.error}` : ""),
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        return err({ type: "sandbox_error", toolName: "execute_code", cause: String(e) });
      }
    },
  };
}
