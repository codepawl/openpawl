import { describe, it, expect, vi, beforeEach } from "bun:test";
import { z } from "zod";
import { ok, err } from "neverthrow";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionResolver } from "../../src/tools/permissions.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import type { ToolDefinition, ToolExecutionContext } from "../../src/tools/types.js";

function makeTool(name: string, overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    displayName: name,
    description: `Test ${name}`,
    category: "file",
    inputSchema: z.object({ value: z.string() }),
    defaultPermission: "auto",
    riskLevel: "safe",
    destructive: false,
    requiresNetwork: false,
    source: "built-in",
    execute: async () => ok({ success: true, data: "result", summary: "ok", duration: 1 }),
    ...overrides,
  };
}

const CTX: ToolExecutionContext = {
  agentId: "coder",
  sessionId: "test-session",
  workingDirectory: "/tmp/test",
};

describe("ToolExecutor", () => {
  let registry: ToolRegistry;
  let permissions: PermissionResolver;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    permissions = new PermissionResolver();
    executor = new ToolExecutor(registry, permissions);
  });

  it("execute() validates input against schema", async () => {
    registry.register(makeTool("test"));
    const result = await executor.execute("test", { value: "hello" }, CTX);
    expect(result.isOk()).toBe(true);
  });

  it("execute() returns validation error for bad input", async () => {
    registry.register(makeTool("test"));
    const result = await executor.execute("test", { value: 123 }, CTX);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("validation_failed");
    }
  });

  it("execute() checks permission before running", async () => {
    registry.register(makeTool("blocked", { defaultPermission: "block" }));
    const result = await executor.execute("blocked", { value: "hi" }, CTX, "block");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("permission_denied");
    }
  });

  it("execute() emits tool:start and tool:done events", async () => {
    registry.register(makeTool("evented"));
    const events: string[] = [];
    executor.on("tool:start", () => events.push("start"));
    executor.on("tool:done", () => events.push("done"));

    await executor.execute("evented", { value: "hi" }, CTX);

    expect(events).toContain("start");
    expect(events).toContain("done");
  });

  it("execute() returns not_found for missing tool", async () => {
    const result = await executor.execute("nonexistent", {}, CTX);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("execute() handles execution failure", async () => {
    registry.register(makeTool("failing", {
      execute: async () => err({ type: "execution_failed", toolName: "failing", cause: "boom" }),
    }));

    const result = await executor.execute("failing", { value: "hi" }, CTX);
    expect(result.isErr()).toBe(true);
  });

  it("executeParallel() runs tools concurrently", async () => {
    registry.register(makeTool("a"));
    registry.register(makeTool("b"));

    const results = await executor.executeParallel(
      [{ toolName: "a", input: { value: "1" } }, { toolName: "b", input: { value: "2" } }],
      CTX,
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.isOk()).toBe(true);
    expect(results[1]!.isOk()).toBe(true);
  });

  it("execute() returns permission_denied for blocked tools", async () => {
    registry.register(makeTool("secret", { defaultPermission: "block" }));
    const result = await executor.execute("secret", { value: "hi" }, CTX, "block");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("permission_denied");
  });
});
