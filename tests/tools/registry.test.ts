import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ok } from "neverthrow";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolDefinition, ToolPermissionConfig } from "../../src/tools/types.js";

function makeTool(name: string, overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    displayName: name,
    description: `Test tool ${name}`,
    category: "file",
    inputSchema: z.object({ path: z.string() }),
    defaultPermission: "auto",
    riskLevel: "safe",
    destructive: false,
    requiresNetwork: false,
    source: "built-in",
    execute: async () => ok({ success: true, data: null, summary: "ok", duration: 0 }),
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  it("register() adds tool to registry", () => {
    const registry = new ToolRegistry();
    const result = registry.register(makeTool("test_tool"));
    expect(result.isOk()).toBe(true);
    expect(registry.has("test_tool")).toBe(true);
  });

  it("register() rejects duplicate name", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("dup"));
    const result = registry.register(makeTool("dup"));
    expect(result.isErr()).toBe(true);
  });

  it("get() returns registered tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("my_tool"));
    expect(registry.get("my_tool")?.name).toBe("my_tool");
  });

  it("get() returns undefined for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("getByCategory() filters correctly", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("a", { category: "file" }));
    registry.register(makeTool("b", { category: "shell" }));
    registry.register(makeTool("c", { category: "file" }));
    expect(registry.getByCategory("file")).toHaveLength(2);
    expect(registry.getByCategory("shell")).toHaveLength(1);
  });

  it("resolveForAgent() includes tools in agent allow list", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("file_read"));
    registry.register(makeTool("shell_exec"));

    const config: ToolPermissionConfig = {
      agents: { coder: { allow: ["file_read"] } },
    };

    const resolved = registry.resolveForAgent("coder", ["file_read", "shell_exec"], config);
    expect(resolved.tools.has("file_read")).toBe(true);
    expect(resolved.tools.has("shell_exec")).toBe(false);
    expect(resolved.blocked).toContain("shell_exec");
  });

  it("resolveForAgent() excludes tools in agent block list", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("file_read"));
    registry.register(makeTool("shell_exec"));

    const config: ToolPermissionConfig = {
      agents: { coder: { block: ["shell_exec"] } },
    };

    const resolved = registry.resolveForAgent("coder", ["file_read", "shell_exec"], config);
    expect(resolved.tools.has("file_read")).toBe(true);
    expect(resolved.blocked).toContain("shell_exec");
  });

  it("resolveForAgent() applies permission override priority", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("file_write", { defaultPermission: "confirm" }));

    const config: ToolPermissionConfig = {
      defaults: { file_write: "session" },
      agents: { coder: { permissions: { file_write: "auto" } } },
    };

    const resolved = registry.resolveForAgent("coder", ["file_write"], config);
    // Agent override (auto) takes priority over global (session)
    expect(resolved.permissions.get("file_write")).toBe("auto");
  });

  it("resolveForAgent() reports blocked tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("dangerous"));

    const config: ToolPermissionConfig = {
      tools: { dangerous: { permission: "block" } },
    };

    const resolved = registry.resolveForAgent("any", ["dangerous"], config);
    expect(resolved.blocked).toContain("dangerous");
    expect(resolved.tools.size).toBe(0);
  });

  it("exportForLLM() produces schemas", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("file_read"));

    const schemas = registry.exportForLLM(["file_read"]);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe("file_read");
    expect(schemas[0]!.parameters).toBeDefined();
  });

  it("unregister() removes tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("removable"));
    expect(registry.has("removable")).toBe(true);

    registry.unregister("removable");
    expect(registry.has("removable")).toBe(false);
  });

  it("events emitted on register/unregister", () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    registry.on("tool:registered", (name: string) => events.push(`reg:${name}`));
    registry.on("tool:unregistered", (name: string) => events.push(`unreg:${name}`));

    registry.register(makeTool("ev_tool"));
    registry.unregister("ev_tool");

    expect(events).toContain("reg:ev_tool");
    expect(events).toContain("unreg:ev_tool");
  });
});
