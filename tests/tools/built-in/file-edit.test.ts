import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createFileEditTool } from "../../../src/tools/built-in/file-edit.js";
import type { ToolExecutionContext } from "../../../src/tools/types.js";

describe("file_edit", () => {
  let tmpDir: string;
  let ctx: ToolExecutionContext;
  const tool = createFileEditTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-fe-test-"));
    ctx = { agentId: "coder", sessionId: "test", workingDirectory: tmpDir };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("replaces unique match", async () => {
    await writeFile(path.join(tmpDir, "code.ts"), 'const x = "old";');
    const result = await tool.execute({ path: "code.ts", search: '"old"', replace: '"new"' }, ctx);
    expect(result.isOk()).toBe(true);
    const content = await readFile(path.join(tmpDir, "code.ts"), "utf-8");
    expect(content).toBe('const x = "new";');
  });

  it("returns error for zero matches", async () => {
    await writeFile(path.join(tmpDir, "code.ts"), "const x = 1;");
    const result = await tool.execute({ path: "code.ts", search: "nonexistent", replace: "y" }, ctx);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.cause).toContain("not found");
  });

  it("returns error for multiple matches", async () => {
    await writeFile(path.join(tmpDir, "code.ts"), "const x = 1;\nconst y = 1;");
    const result = await tool.execute({ path: "code.ts", search: "= 1", replace: "= 2" }, ctx);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.cause).toContain("2 times");
  });

  it("blocks path traversal", async () => {
    const result = await tool.execute({ path: "../../../etc/hosts", search: "x", replace: "y" }, ctx);
    expect(result.isErr()).toBe(true);
  });
});
