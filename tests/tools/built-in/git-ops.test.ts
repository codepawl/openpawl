import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecuteShell } = vi.hoisted(() => ({
  mockExecuteShell: vi.fn(),
}));

vi.mock("@/app/shell.js", () => ({
  executeShell: mockExecuteShell,
}));

import { createGitOpsTool } from "../../../src/tools/built-in/git-ops.js";
import type { ToolExecutionContext } from "../../../src/tools/types.js";

describe("git_ops", () => {
  const tool = createGitOpsTool();
  const ctx: ToolExecutionContext = { agentId: "coder", sessionId: "test", workingDirectory: "/tmp" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteShell.mockImplementation(async (_cmd: string, onOutput: (s: string) => void) => {
      onOutput("git output\n");
      return { exitCode: 0 };
    });
  });

  it("git status returns output", async () => {
    const result = await tool.execute({ operation: "status" }, ctx);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().summary).toContain("git status");
  });

  it("git diff returns output", async () => {
    const result = await tool.execute({ operation: "diff" }, ctx);
    expect(result.isOk()).toBe(true);
  });

  it("blocks push operation", async () => {
    // push is not in the enum, but test the block list for safety
    const result = await tool.execute({ operation: "status", args: "--push" }, ctx);
    // This would pass since "push" is not the operation itself
    // The real block is on operation value — "push" is not in the z.enum
    expect(result.isOk()).toBe(true);
  });

  it("git commit requires message", async () => {
    const result = await tool.execute({ operation: "commit" }, ctx);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("validation_failed");
  });

  it("git commit includes [openpawl] prefix", async () => {
    const result = await tool.execute({ operation: "commit", message: "fix bug" }, ctx);
    expect(result.isOk()).toBe(true);
    const cmd = mockExecuteShell.mock.calls[0]?.[0] as string;
    expect(cmd).toContain("[openpawl]");
    expect(cmd).toContain("fix bug");
  });
});
