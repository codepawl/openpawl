/**
 * web_search — placeholder tool (returns "not configured" error).
 */

import { z } from "zod";
import { err } from "neverthrow";
import type { ToolDefinition } from "../types.js";

const inputSchema = z.object({
  query: z.string().describe("Search query"),
  maxResults: z.number().optional().default(5).describe("Max results to return"),
});

export function createWebSearchTool(): ToolDefinition {
  return {
    name: "web_search",
    displayName: "Web Search",
    description: "Search the web for information. Returns relevant results.",
    category: "web",
    inputSchema,
    defaultPermission: "auto",
    riskLevel: "safe",
    destructive: false,
    requiresNetwork: true,
    source: "built-in",
    execute: async () => {
      return err({
        type: "execution_failed",
        toolName: "web_search",
        cause: "Web search not configured. Add a search provider in config.",
      });
    },
  };
}
