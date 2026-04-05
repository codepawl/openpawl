/**
 * file_read — read file contents safely within working directory.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ok, err } from "neverthrow";
import { resolveSafePath } from "../../core/sandbox.js";
import type { ToolDefinition, ToolOutput } from "../types.js";

const inputSchema = z.object({
  path: z.string().describe("File path relative to working directory"),
  maxLines: z.number().optional().describe("Max lines to read"),
  startLine: z.number().optional().describe("Start reading from this line (1-indexed)"),
});

export function createFileReadTool(): ToolDefinition {
  return {
    name: "file_read",
    displayName: "Read File",
    description: "Read the contents of a file. Returns the file content as text.",
    category: "file",
    inputSchema,
    defaultPermission: "auto",
    riskLevel: "safe",
    destructive: false,
    requiresNetwork: false,
    source: "built-in",
    execute: async (input, context) => {
      const { path: filePath, maxLines, startLine } = input as z.infer<typeof inputSchema>;
      const start = Date.now();

      let resolved: string;
      try {
        resolved = resolveSafePath(filePath, context.workingDirectory);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "file_read", cause: String(e) });
      }

      try {
        // Check for binary
        const { createReadStream } = await import("node:fs");
        const isBinary = await new Promise<boolean>((resolve) => {
          const stream = createReadStream(resolved, { start: 0, end: 8191 });
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          stream.on("end", () => {
            const data = Buffer.concat(chunks);
            resolve(data.includes(0));
          });
          stream.on("error", () => resolve(false));
        });

        if (isBinary) {
          return err({ type: "execution_failed", toolName: "file_read", cause: "Binary file, cannot read as text" });
        }

        const content = await readFile(resolved, "utf-8");
        let lines = content.split("\n");

        if (startLine) {
          lines = lines.slice(Math.max(0, startLine - 1));
        }
        if (maxLines) {
          lines = lines.slice(0, maxLines);
        }

        const result = lines.join("\n");
        const stats = await stat(resolved);
        const relPath = path.relative(context.workingDirectory, resolved);

        const output: ToolOutput = {
          success: true,
          data: result,
          summary: `Read ${relPath} (${lines.length} lines, ${stats.size} bytes)`,
          fullOutput: result,
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "file_read", cause: String(e) });
      }
    },
  };
}
