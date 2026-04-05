import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createFileReadTool } from "../../../src/tools/built-in/file-read.js";
import type { ToolExecutionContext } from "../../../src/tools/types.js";

describe("file_read", () => {
  let tmpDir: string;
  let ctx: ToolExecutionContext;
  const tool = createFileReadTool();

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-fr-test-"));
    ctx = { agentId: "coder", sessionId: "test", workingDirectory: tmpDir };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads file successfully", async () => {
    await writeFile(path.join(tmpDir, "hello.txt"), "Hello World\nLine 2\n");
    const result = await tool.execute({ path: "hello.txt" }, ctx);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().summary).toContain("hello.txt");
    expect(result._unsafeUnwrap().data).toContain("Hello World");
  });

  it("returns error for non-existent file", async () => {
    const result = await tool.execute({ path: "missing.txt" }, ctx);
    expect(result.isErr()).toBe(true);
  });

  it("blocks path traversal", async () => {
    const result = await tool.execute({ path: "../../../etc/passwd" }, ctx);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.cause).toContain("traversal");
  });

  it("handles maxLines parameter", async () => {
    await writeFile(path.join(tmpDir, "multi.txt"), "L1\nL2\nL3\nL4\nL5\n");
    const result = await tool.execute({ path: "multi.txt", maxLines: 2 }, ctx);
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap().data as string;
    expect(data.split("\n").length).toBeLessThanOrEqual(3); // 2 lines + possible trailing
  });

  it("detects binary file", async () => {
    const buf = Buffer.alloc(100);
    buf[50] = 0; // null byte
    await writeFile(path.join(tmpDir, "binary.bin"), buf);
    const result = await tool.execute({ path: "binary.bin" }, ctx);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.cause).toContain("Binary");
  });

  it("output summary includes file name and size", async () => {
    await writeFile(path.join(tmpDir, "info.txt"), "content");
    const result = await tool.execute({ path: "info.txt" }, ctx);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().summary).toContain("info.txt");
    expect(result._unsafeUnwrap().summary).toContain("bytes");
  });
});
