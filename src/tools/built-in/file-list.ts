/**
 * file_list — list directory contents recursively.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ok, err } from "neverthrow";
import { resolveSafePath } from "../../core/sandbox.js";
import type { ToolDefinition, ToolOutput } from "../types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".next", "dist", ".cache", "coverage"]);
const MAX_ENTRIES = 500;

const inputSchema = z.object({
  path: z.string().optional().default(".").describe("Directory path relative to working directory"),
  maxDepth: z.number().optional().default(2).describe("Max recursion depth (0 = current dir only)"),
  includeHidden: z.boolean().optional().default(false),
});

export function createFileListTool(): ToolDefinition {
  return {
    name: "file_list",
    displayName: "List Directory",
    description: "List files and directories. Returns names with type indicators.",
    category: "file",
    inputSchema,
    defaultPermission: "auto",
    riskLevel: "safe",
    destructive: false,
    requiresNetwork: false,
    source: "built-in",
    execute: async (input, context) => {
      const { path: dirPath, maxDepth, includeHidden } = input as z.infer<typeof inputSchema>;
      const start = Date.now();

      let resolved: string;
      try {
        resolved = resolveSafePath(dirPath, context.workingDirectory);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "file_list", cause: String(e) });
      }

      try {
        const entries: string[] = [];
        let fileCount = 0;
        let dirCount = 0;

        await listRecursive(resolved, "", maxDepth, includeHidden, entries, { count: 0 });

        for (const e of entries) {
          if (e.endsWith("/")) dirCount++;
          else fileCount++;
        }

        const relPath = path.relative(context.workingDirectory, resolved) || ".";
        const output: ToolOutput = {
          success: true,
          data: entries,
          summary: `Listed ${relPath}: ${fileCount} files, ${dirCount} directories`,
          fullOutput: entries.join("\n"),
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        return err({ type: "execution_failed", toolName: "file_list", cause: String(e) });
      }
    },
  };
}

async function listRecursive(
  base: string,
  prefix: string,
  depth: number,
  includeHidden: boolean,
  results: string[],
  counter: { count: number },
): Promise<void> {
  if (counter.count >= MAX_ENTRIES) return;

  const entries = await readdir(base, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (counter.count >= MAX_ENTRIES) break;
    if (!includeHidden && entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name) && entry.isDirectory()) continue;

    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push(relPath + "/");
      counter.count++;
      if (depth > 0) {
        await listRecursive(path.join(base, entry.name), relPath, depth - 1, includeHidden, results, counter);
      }
    } else {
      results.push(relPath);
      counter.count++;
    }
  }
}
