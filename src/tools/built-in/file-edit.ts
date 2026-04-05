/**
 * file_edit — search/replace in file with uniqueness check.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ok, err } from "neverthrow";
import { resolveSafePath } from "../../core/sandbox.js";
import type { ToolDefinition, ToolOutput, ToolError } from "../types.js";

const inputSchema = z.object({
  path: z.string().describe("File path relative to working directory"),
  search: z.string().describe("Exact text to find (must be unique in file)"),
  replace: z.string().describe("Replacement text"),
});

export function createFileEditTool(): ToolDefinition {
  return {
    name: "file_edit",
    displayName: "Edit File",
    description: "Edit an existing file by replacing a specific string. The search string must match exactly one location.",
    category: "file",
    inputSchema,
    defaultPermission: "confirm",
    riskLevel: "moderate",
    destructive: true,
    requiresNetwork: false,
    source: "built-in",
    execute: async (input, context) => {
      const { path: filePath, search, replace: replacement } = input as z.infer<typeof inputSchema>;
      const start = Date.now();

      let resolved: string;
      try {
        resolved = resolveSafePath(filePath, context.workingDirectory);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "file_edit", cause: String(e) });
      }

      try {
        const content = await readFile(resolved, "utf-8");

        // Count occurrences
        let count = 0;
        let idx = 0;
        while ((idx = content.indexOf(search, idx)) !== -1) {
          count++;
          idx += search.length;
        }

        if (count === 0) {
          return err({ type: "execution_failed", toolName: "file_edit", cause: "Search string not found in file" });
        }
        if (count > 1) {
          return err({ type: "execution_failed", toolName: "file_edit", cause: `Search string found ${count} times, must be unique` });
        }

        const newContent = content.replace(search, replacement);

        // Atomic write
        const tmpPath = resolved + ".tmp";
        await writeFile(tmpPath, newContent, "utf-8");
        await rename(tmpPath, resolved);

        const relPath = path.relative(context.workingDirectory, resolved);
        const output: ToolOutput = {
          success: true,
          data: { path: relPath, searchLen: search.length, replaceLen: replacement.length },
          summary: `Edited ${relPath}: replaced ${search.length} chars with ${replacement.length} chars`,
          filesModified: [resolved],
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        if ((e as { type?: string }).type === "execution_failed") return err(e as ToolError);
        return err({ type: "execution_failed", toolName: "file_edit", cause: String(e) });
      }
    },
  };
}
