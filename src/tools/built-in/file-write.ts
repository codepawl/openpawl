/**
 * file_write — create or overwrite file with atomic writes.
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ok, err } from "neverthrow";
import { resolveSafePath } from "../../core/sandbox.js";
import type { ToolDefinition, ToolOutput } from "../types.js";

const inputSchema = z.object({
  path: z.string().describe("File path relative to working directory"),
  content: z.string().describe("File content to write"),
  createDirs: z.boolean().optional().default(true).describe("Create parent directories if needed"),
});

export function createFileWriteTool(): ToolDefinition {
  return {
    name: "file_write",
    displayName: "Write File",
    description: "Create a new file or overwrite an existing file with the given content.",
    category: "file",
    inputSchema,
    defaultPermission: "confirm",
    riskLevel: "moderate",
    destructive: true,
    requiresNetwork: false,
    source: "built-in",
    execute: async (input, context) => {
      const { path: filePath, content, createDirs } = input as z.infer<typeof inputSchema>;
      const start = Date.now();

      let resolved: string;
      try {
        resolved = resolveSafePath(filePath, context.workingDirectory);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "file_write", cause: String(e) });
      }

      try {
        if (createDirs) {
          await mkdir(path.dirname(resolved), { recursive: true });
        }

        // Atomic write
        const tmpPath = resolved + ".tmp";
        await writeFile(tmpPath, content, "utf-8");
        await rename(tmpPath, resolved);

        const relPath = path.relative(context.workingDirectory, resolved);
        const output: ToolOutput = {
          success: true,
          data: { path: relPath, bytes: Buffer.byteLength(content) },
          summary: `Wrote ${relPath} (${Buffer.byteLength(content)} bytes)`,
          filesModified: [resolved],
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "file_write", cause: String(e) });
      }
    },
  };
}
