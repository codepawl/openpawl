/**
 * Adapt MCP tool specs to OpenPawl ToolDefinition.
 */

import { z } from "zod";
import { ok, err } from "neverthrow";
import type { ToolDefinition, PermissionLevel, ToolOutput } from "../types.js";
import type { McpToolSpec } from "./mcp-types.js";

/**
 * Convert an MCP tool spec to an OpenPawl ToolDefinition.
 */
export function adaptMcpTool(
  serverName: string,
  spec: McpToolSpec,
  defaultPermission: PermissionLevel,
  callTool: (name: string, input: unknown) => Promise<unknown>,
): ToolDefinition {
  const namespacedName = `mcp_${serverName}_${spec.name}`;

  return {
    name: namespacedName,
    displayName: `${spec.name} (${serverName})`,
    description: spec.description || `MCP tool from ${serverName}`,
    category: "mcp",
    inputSchema: jsonSchemaToZod(spec.inputSchema),
    defaultPermission,
    riskLevel: "moderate",
    destructive: false,
    requiresNetwork: true,
    source: "mcp",
    execute: async (input, _context) => {
      const start = Date.now();
      try {
        const result = await callTool(spec.name, input);
        const output: ToolOutput = {
          success: true,
          data: result,
          summary: `${spec.name}: completed`,
          fullOutput: typeof result === "string" ? result : JSON.stringify(result),
          duration: Date.now() - start,
        };
        return ok(output);
      } catch (e) {
        return err({
          type: "mcp_error" as const,
          toolName: namespacedName,
          server: serverName,
          cause: String(e),
        });
      }
    },
  };
}

/**
 * Convert a JSON Schema object to a Zod schema.
 * Handles basic types; falls back to z.unknown() for complex schemas.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType<unknown> {
  if (!schema || typeof schema !== "object") return z.unknown();

  const type = schema.type as string | undefined;

  if (type === "string") {
    let s = z.string();
    if (schema.description) s = s.describe(schema.description as string);
    if (schema.enum) return z.enum(schema.enum as [string, ...string[]]);
    return s;
  }

  if (type === "number" || type === "integer") {
    let n = z.number();
    if (schema.description) n = n.describe(schema.description as string);
    return n;
  }

  if (type === "boolean") {
    return z.boolean();
  }

  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    return z.array(items ? jsonSchemaToZod(items) : z.unknown());
  }

  if (type === "object" || schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = new Set((schema.required as string[]) ?? []);

    if (!props) return z.record(z.unknown());

    const shape: Record<string, z.ZodType<unknown>> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      const zodProp = jsonSchemaToZod(propSchema);
      shape[key] = required.has(key) ? zodProp : zodProp.optional();
    }
    return z.object(shape);
  }

  return z.unknown();
}
