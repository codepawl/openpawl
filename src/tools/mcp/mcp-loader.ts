/**
 * MCP tool loader — connects to MCP servers and loads tools.
 * Best-effort: failures are logged, never block startup.
 */

import { Result, ok, err } from "neverthrow";
import type { ToolDefinition, ToolError } from "../types.js";
import type { McpServerConfig, McpToolSpec } from "./mcp-types.js";
import { adaptMcpTool } from "./mcp-adapter.js";

export class McpLoader {
  private connectedServers = new Map<string, ToolDefinition[]>();

  /**
   * Connect to an MCP server, list tools, adapt them.
   */
  async loadTools(server: McpServerConfig): Promise<Result<ToolDefinition[], ToolError>> {
    try {
      const specs = await this.fetchToolSpecs(server.url);
      const permission = server.defaultPermission ?? "confirm";

      const tools = specs.map((spec) =>
        adaptMcpTool(server.name, spec, permission, (name, input) =>
          this.callTool(server.url, name, input),
        ),
      );

      this.connectedServers.set(server.name, tools);
      return ok(tools);
    } catch (e) {
      return err({
        type: "mcp_error",
        toolName: `mcp_${server.name}`,
        server: server.name,
        cause: String(e),
      });
    }
  }

  async disconnect(serverName: string): Promise<void> {
    this.connectedServers.delete(serverName);
  }

  getConnectedServers(): string[] {
    return [...this.connectedServers.keys()];
  }

  getToolsForServer(serverName: string): ToolDefinition[] {
    return this.connectedServers.get(serverName) ?? [];
  }

  private async fetchToolSpecs(url: string): Promise<McpToolSpec[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const resp = await fetch(`${url.replace(/\/$/, "")}/tools/list`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!resp.ok) {
        throw new Error(`MCP server returned ${resp.status}`);
      }

      const data = await resp.json() as { tools?: McpToolSpec[] };
      return data.tools ?? [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callTool(serverUrl: string, toolName: string, input: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const resp = await fetch(`${serverUrl.replace(/\/$/, "")}/tools/call`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: toolName, arguments: input }),
      });

      if (!resp.ok) {
        throw new Error(`MCP tool call failed: ${resp.status}`);
      }

      const data = await resp.json() as { content?: unknown };
      return data.content ?? data;
    } finally {
      clearTimeout(timeout);
    }
  }
}
