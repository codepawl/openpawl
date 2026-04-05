import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecuteShell } = vi.hoisted(() => ({
  mockExecuteShell: vi.fn(),
}));

vi.mock("@/app/shell.js", () => ({
  executeShell: mockExecuteShell,
}));

import { createShellExecTool } from "../../../src/tools/built-in/shell-exec.js";
import type { ToolExecutionContext } from "../../../src/tools/types.js";

describe("shell_exec", () => {
  const tool = createShellExecTool();
  const ctx: ToolExecutionContext = { agentId: "coder", sessionId: "test", workingDirectory: "/tmp" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteShell.mockImplementation(async (_cmd: string, onOutput: (s: string) => void) => {
      onOutput("output line\n");
      return { exitCode: 0 };
    });
  });

  it("executes simple command", async () => {
    const result = await tool.execute({ command: "echo hello" }, ctx);
    expect(result.isOk()).toBe(true);
    expect(mockExecuteShell).toHaveBeenCalledTimes(1);
  });

  it("captures output", async () => {
    const result = await tool.execute({ command: "ls" }, ctx);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().fullOutput).toContain("output line");
  });

  it("blocks dangerous commands", async () => {
    const result = await tool.execute({ command: "rm -rf /" }, ctx);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.cause).toContain("Blocked");
    expect(mockExecuteShell).not.toHaveBeenCalled();
  });

  it("blocks sudo rm", async () => {
    const result = await tool.execute({ command: "sudo rm -rf /home" }, ctx);
    expect(result.isErr()).toBe(true);
  });

  it("returns exit code in output", async () => {
    mockExecuteShell.mockImplementation(async (_cmd: string, onOutput: (s: string) => void) => {
      onOutput("error\n");
      return { exitCode: 1 };
    });

    const result = await tool.execute({ command: "false" }, ctx);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data).toEqual(expect.objectContaining({ exitCode: 1 }));
  });
});
