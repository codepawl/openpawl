import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createShellExecTool, type ShellExecData } from "../../../src/tools/built-in/shell-exec.js";
import type { ToolExecutionContext } from "../../../src/tools/types.js";

describe("shell_exec", () => {
  let tmpDir: string;
  let ctx: ToolExecutionContext;
  const tool = createShellExecTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-shell-test-"));
    ctx = { agentId: "coder", sessionId: "test", workingDirectory: tmpDir };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("captures exitCode, stdout, and stderr separately on failure", async () => {
    const result = await tool.execute(
      { command: "bash -c 'echo out; echo err >&2; exit 127'", timeout: 5000 },
      ctx,
    );
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.success).toBe(false);

    const data = result.value.data as ShellExecData;
    expect(data.exitCode).toBe(127);
    expect(data.stdout).toContain("out");
    expect(data.stderr).toContain("err");
    // stderr should NOT leak into stdout
    expect(data.stdout).not.toContain("err");
  });

  it("reports success on exit 0", async () => {
    const result = await tool.execute({ command: "echo hello", timeout: 5000 }, ctx);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.success).toBe(true);
    const data = result.value.data as ShellExecData;
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toContain("hello");
    expect(data.stderr).toBe("");
  });
});
