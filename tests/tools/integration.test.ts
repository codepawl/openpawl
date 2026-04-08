import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionResolver } from "../../src/tools/permissions.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { registerBuiltInTools } from "../../src/tools/built-in/index.js";
import type { ToolExecutionContext, ToolPermissionConfig } from "../../src/tools/types.js";

describe("Tool integration", () => {
  let tmpDir: string;
  let registry: ToolRegistry;
  let permissions: PermissionResolver;
  let executor: ToolExecutor;
  let ctx: ToolExecutionContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-tool-int-"));
    registry = new ToolRegistry();
    registerBuiltInTools(registry);
    permissions = new PermissionResolver();
    executor = new ToolExecutor(registry, permissions);
    ctx = { agentId: "coder", sessionId: "test", workingDirectory: tmpDir };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("full flow: register → resolve → execute → check result", async () => {
    // All built-in tools registered
    expect(registry.has("file_read")).toBe(true);
    expect(registry.has("file_write")).toBe(true);

    // Resolve for agent
    const config: ToolPermissionConfig = {};
    const resolved = registry.resolveForAgent("coder", ["file_read", "file_write"], config);
    expect(resolved.tools.size).toBe(2);

    // Create a file
    await writeFile(path.join(tmpDir, "test.txt"), "hello world");

    // Execute file_read
    const readResult = await executor.execute("file_read", { path: "test.txt" }, ctx);
    expect(readResult.isOk()).toBe(true);
    expect(readResult._unsafeUnwrap().data).toContain("hello world");
  });

  it("permission confirm flow: blocked tool returns denied", async () => {
    const config: ToolPermissionConfig = {
      tools: { file_write: { permission: "block" } },
    };

    const resolved = registry.resolveForAgent("coder", ["file_write"], config);
    expect(resolved.blocked).toContain("file_write");
  });

  it("per-project config overrides global config", async () => {
    const config: ToolPermissionConfig = {
      defaults: { shell_exec: "confirm" },
      agents: { coder: { permissions: { shell_exec: "auto" } } },
    };

    const resolved = registry.resolveForAgent("coder", ["shell_exec"], config);
    expect(resolved.permissions.get("shell_exec")).toBe("auto");
  });

  it("LLM schema export includes all resolved tools", () => {
    const schemas = registry.exportForLLM(["file_read", "file_write", "shell_exec"]);
    expect(schemas.length).toBe(3);
    for (const schema of schemas) {
      expect(schema.name).toBeDefined();
      expect(schema.description).toBeDefined();
      expect(schema.parameters).toBeDefined();
    }
  });

  it("9 built-in tools are registered", () => {
    const names = registry.getNames();
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("file_edit");
    expect(names).toContain("file_list");
    expect(names).toContain("shell_exec");
    expect(names).toContain("git_ops");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("execute_code");
    expect(names.length).toBe(9);
  });
});
