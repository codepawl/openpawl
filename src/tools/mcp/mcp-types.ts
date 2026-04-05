/**
 * MCP (Model Context Protocol) types.
 */

import type { PermissionLevel } from "../types.js";

export interface McpServerConfig {
  name: string;
  url: string;
  defaultPermission?: PermissionLevel;
}

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
