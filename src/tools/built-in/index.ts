/**
 * Register all built-in tools with the registry.
 */

import type { ToolRegistry } from "../registry.js";
import { createFileReadTool } from "./file-read.js";
import { createFileWriteTool } from "./file-write.js";
import { createFileEditTool } from "./file-edit.js";
import { createFileListTool } from "./file-list.js";
import { createShellExecTool } from "./shell-exec.js";
import { createGitOpsTool } from "./git-ops.js";
import { createWebSearchTool } from "./web-search.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createExecuteCodeTool } from "./execute-code.js";

export function registerBuiltInTools(registry: ToolRegistry): void {
  registry.registerMany([
    createFileReadTool(),
    createFileWriteTool(),
    createFileEditTool(),
    createFileListTool(),
    createShellExecTool(),
    createGitOpsTool(),
    createWebSearchTool(),
    createWebFetchTool(),
    createExecuteCodeTool(),
  ]);
}
