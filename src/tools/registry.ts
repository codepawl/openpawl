/**
 * Central tool registry. All tools register here.
 * Router and Dispatcher query it for agent tool sets.
 */

import { EventEmitter } from "node:events";
import { Result, ok, err } from "neverthrow";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ToolDefinition,
  ToolCategory,
  ToolPermissionConfig,
  PermissionLevel,
  ResolvedToolSet,
  LLMToolSchema,
  ToolError,
} from "./types.js";

export class ToolRegistry extends EventEmitter {
  private tools = new Map<string, ToolDefinition>();

  // ── Registration ───────────────────────────────────────────────────────

  register(tool: ToolDefinition): Result<void, ToolError> {
    if (this.tools.has(tool.name)) {
      return err({ type: "validation_failed", toolName: tool.name, errors: [`Tool "${tool.name}" already registered`] });
    }
    this.tools.set(tool.name, tool);
    this.emit("tool:registered", tool.name);
    return ok(undefined);
  }

  registerMany(tools: ToolDefinition[]): Result<void, ToolError> {
    for (const tool of tools) {
      // Allow overwrite in batch registration (for re-registration)
      this.tools.set(tool.name, tool);
      this.emit("tool:registered", tool.name);
    }
    return ok(undefined);
  }

  unregister(toolName: string): Result<void, ToolError> {
    if (!this.tools.has(toolName)) {
      return err({ type: "not_found", toolName });
    }
    this.tools.delete(toolName);
    this.emit("tool:unregistered", toolName);
    return ok(undefined);
  }

  // ── Lookup ─────────────────────────────────────────────────────────────

  get(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  getByCategory(category: ToolCategory): ToolDefinition[] {
    return this.getAll().filter((t) => t.category === category);
  }

  getNames(): string[] {
    return [...this.tools.keys()];
  }

  // ── Agent Tool Resolution ──────────────────────────────────────────────

  resolveForAgent(
    agentId: string,
    requestedTools: string[],
    permissionConfig: ToolPermissionConfig,
  ): ResolvedToolSet {
    const resolved = new Map<string, ToolDefinition>();
    const permissions = new Map<string, PermissionLevel>();
    const blocked: string[] = [];

    const agentConfig = permissionConfig.agents?.[agentId];

    for (const toolName of requestedTools) {
      const tool = this.tools.get(toolName);
      if (!tool) continue;

      // Check agent block list
      if (agentConfig?.block?.includes(toolName)) {
        blocked.push(toolName);
        continue;
      }

      // Check agent allow list (if defined, only allowed tools pass)
      if (agentConfig?.allow && !agentConfig.allow.includes(toolName)) {
        blocked.push(toolName);
        continue;
      }

      // Resolve effective permission (priority order)
      const permission = resolvePermission(toolName, agentId, tool.defaultPermission, permissionConfig);

      if (permission === "block") {
        blocked.push(toolName);
        continue;
      }

      resolved.set(toolName, tool);
      permissions.set(toolName, permission);
    }

    return { tools: resolved, permissions, blocked };
  }

  // ── Schema Export ──────────────────────────────────────────────────────

  exportForLLM(toolNames: Iterable<string>): LLMToolSchema[] {
    const schemas: LLMToolSchema[] = [];
    for (const name of toolNames) {
      const tool = this.tools.get(name);
      if (!tool) continue;

      let parameters: Record<string, unknown>;
      try {
        parameters = zodToJsonSchema(tool.inputSchema, { target: "openApi3" }) as Record<string, unknown>;
      } catch {
        parameters = { type: "object", properties: {} };
      }

      schemas.push({
        name: tool.name,
        description: tool.description,
        parameters,
      });
    }
    return schemas;
  }

  /** Export tools in OpenAI native function-calling format. */
  exportForAPI(toolNames: Iterable<string>): import("../providers/stream-types.js").NativeToolDefinition[] {
    return this.exportForLLM(toolNames).map((s) => ({
      type: "function" as const,
      function: {
        name: s.name,
        description: s.description,
        parameters: s.parameters,
      },
    }));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolvePermission(
  toolName: string,
  agentId: string,
  defaultPermission: PermissionLevel,
  config: ToolPermissionConfig,
): PermissionLevel {
  // 1. Agent-specific permission override
  const agentPerm = config.agents?.[agentId]?.permissions?.[toolName];
  if (agentPerm) return agentPerm;

  // 2. Tool-specific permission override
  const toolPerm = config.tools?.[toolName]?.permission;
  if (toolPerm) return toolPerm;

  // 3. Global default override
  const globalPerm = config.defaults?.[toolName];
  if (globalPerm) return globalPerm;

  // 4. Tool's built-in default
  return defaultPermission;
}
