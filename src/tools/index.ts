/**
 * Tool system — registry, permissions, executor, built-in tools, MCP.
 */

// Types
export type {
  ToolDefinition,
  ToolCategory,
  PermissionLevel,
  RiskLevel,
  ToolSource,
  ToolExecuteFn,
  ToolExecutionContext,
  ToolOutput,
  ToolError,
  ToolPermissionConfig,
  ResolvedToolSet,
  LLMToolSchema,
  PermissionCheckResult,
} from "./types.js";

// Registry
export { ToolRegistry } from "./registry.js";

// Permissions
export { PermissionResolver } from "./permissions.js";

// Executor
export { ToolExecutor } from "./executor.js";

// Built-in tools
export { registerBuiltInTools } from "./built-in/index.js";

// MCP
export { McpLoader } from "./mcp/mcp-loader.js";
export { adaptMcpTool, jsonSchemaToZod } from "./mcp/mcp-adapter.js";
export type { McpServerConfig, McpToolSpec } from "./mcp/mcp-types.js";
