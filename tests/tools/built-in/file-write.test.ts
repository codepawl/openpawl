import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFileWriteTool } from "../../../src/tools/built-in/file-write.js";
import type { ToolExecutionContext } from "../../../src/tools/types.js";

describe("file_write", () => {
  let tmpDir: string;
  let ctx: ToolExecutionContext;
  const tool = createFileWriteTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-fw-test-"));
    ctx = { agentId: "coder", sessionId: "test", workingDirectory: tmpDir };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates new file", async () => {
    const result = await tool.execute({ path: "new.txt", content: "hello" }, ctx);
    expect(result.isOk()).toBe(true);
    const content = await readFile(path.join(tmpDir, "new.txt"), "utf-8");
    expect(content).toBe("hello");
  });

  it("overwrites existing file", async () => {
    await writeFile(path.join(tmpDir, "old.txt"), "old");
    const result = await tool.execute({ path: "old.txt", content: "new" }, ctx);
    expect(result.isOk()).toBe(true);
    const content = await readFile(path.join(tmpDir, "old.txt"), "utf-8");
    expect(content).toBe("new");
  });

  it("creates parent directories", async () => {
    const result = await tool.execute({ path: "a/b/c/deep.txt", content: "deep", createDirs: true }, ctx);
    expect(result.isOk()).toBe(true);
    expect(existsSync(path.join(tmpDir, "a/b/c/deep.txt"))).toBe(true);
  });

  it("blocks path traversal", async () => {
    const result = await tool.execute({ path: "../../escape.txt", content: "bad" }, ctx);
    expect(result.isErr()).toBe(true);
  });

  it("atomic write (no .tmp left)", async () => {
    await tool.execute({ path: "atomic.txt", content: "data" }, ctx);
    expect(existsSync(path.join(tmpDir, "atomic.txt.tmp"))).toBe(false);
    expect(existsSync(path.join(tmpDir, "atomic.txt"))).toBe(true);
  });

  it("reports filesModified in output", async () => {
    const result = await tool.execute({ path: "tracked.txt", content: "data" }, ctx);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().filesModified).toBeDefined();
    expect(result._unsafeUnwrap().filesModified!.length).toBe(1);
  });
});
