import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ToolOutputHandler } from "../../src/context/tool-output-handler.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let workDir: string;
let handler: ToolOutputHandler;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "openpawl-test-"));
  handler = new ToolOutputHandler(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("processToolOutput", () => {
  it("returns small output as-is with no scratch file", async () => {
    const output = "Hello world";
    const result = await handler.processToolOutput("file_read", output);

    expect(result.content).toBe(output);
    expect(result.truncated).toBe(false);
    expect(result.scratchFile).toBeUndefined();
    expect(result.originalSize).toBe(output.length);
  });

  it("returns output exactly at threshold as-is", async () => {
    const output = "x".repeat(4000);
    const result = await handler.processToolOutput("file_read", output);

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(output);
  });

  it("truncates output over threshold and creates scratch file", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"content".repeat(10)}`);
    const output = lines.join("\n");
    const result = await handler.processToolOutput("file_read", output);

    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(output.length);
    expect(result.scratchFile).toBeTruthy();
    expect(result.content.length).toBeLessThan(output.length);
    expect(result.content).toContain("[Tool output truncated");
    expect(result.content).toContain("[Full output saved to:");
    expect(result.content).toContain(result.scratchFile!);
  });

  it("scratch file contains full original output", async () => {
    const output = "data ".repeat(2000);
    const result = await handler.processToolOutput("generic_tool", output);

    expect(result.scratchFile).toBeTruthy();
    const saved = await readFile(result.scratchFile!, "utf-8");
    expect(saved).toBe(output);
  });
});

describe("smart previews by tool type", () => {
  it("file_read: first 15 + last 5 lines + line count", async () => {
    // Each line ~60 chars × 100 = ~6000 chars (over 4000 threshold)
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"code here ".repeat(5)}`);
    const output = lines.join("\n");
    const result = await handler.processToolOutput("file_read", output);

    expect(result.truncated).toBe(true);
    // Should contain first lines
    expect(result.content).toContain("line 0:");
    expect(result.content).toContain("line 14:");
    // Should contain last lines
    expect(result.content).toContain("line 99:");
    expect(result.content).toContain("line 95:");
    // Should contain line count
    expect(result.content).toContain("100 lines total");
    // Should NOT contain middle lines
    expect(result.content).not.toContain("line 50:");
  });

  it("shell_exec: last 20 lines", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `output ${i} ${"x".repeat(50)}`);
    const output = lines.join("\n");
    const result = await handler.processToolOutput("shell_exec", output);

    expect(result.truncated).toBe(true);
    // Should contain last 20 lines
    expect(result.content).toContain("output 99");
    expect(result.content).toContain("output 80");
    // Should indicate lines above
    expect(result.content).toContain("lines above");
    // Should not have early lines
    expect(result.content).not.toContain("output 50");
  });

  it("directory listing: entries + count", async () => {
    const entries = Array.from({ length: 100 }, (_, i) => `src/components/module_${i}/index.ts ${"padding".repeat(5)}`);
    const output = entries.join("\n");
    const result = await handler.processToolOutput("file_list", output);

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("module_0");
    expect(result.content).toContain("more entries");
    expect(result.content).toContain("100 total");
  });

  it("search/grep: first 15 matches + total count", async () => {
    const matches = Array.from({ length: 80 }, (_, i) => `src/file${i}.ts:10: match ${i} ${"context".repeat(10)}`);
    const output = matches.join("\n");
    const result = await handler.processToolOutput("grep", output);

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("src/file0.ts:10: match 0");
    expect(result.content).toContain("src/file14.ts:10: match 14");
    expect(result.content).toContain("more matches");
    expect(result.content).toContain("80 total");
  });

  it("generic tool: first 15 + last 5 lines", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `data ${i} ${"padding".repeat(10)}`);
    const output = lines.join("\n");
    const result = await handler.processToolOutput("unknown_tool", output);

    expect(result.truncated).toBe(true);
    expect(result.content).toContain("data 0");
    expect(result.content).toContain("data 14");
    expect(result.content).toContain("data 99");
    expect(result.content).toContain("lines omitted");
  });

  it("detects tool type from various name patterns", async () => {
    const output = ("x".repeat(80) + "\n").repeat(100); // ~8100 chars

    // file_read variants
    const r1 = await handler.processToolOutput("read_file", output);
    expect(r1.content).toContain("lines total");

    // shell variants
    const r2 = await handler.processToolOutput("bash", output);
    expect(r2.content).toContain("lines above");

    // search variants
    const r3 = await handler.processToolOutput("ripgrep", output);
    expect(r3.content).toContain("matches");
  });
});

describe("custom config", () => {
  it("respects custom inlineMaxChars", async () => {
    const small = new ToolOutputHandler(workDir, { inlineMaxChars: 50 });
    const output = "x".repeat(100);
    const result = await small.processToolOutput("test", output);

    expect(result.truncated).toBe(true);
  });
});

describe("cleanup", () => {
  it("deletes scratch directory", async () => {
    // Create a scratch file first
    const output = "y".repeat(5000);
    await handler.processToolOutput("test", output);

    const scratchDir = join(workDir, ".openpawl", "scratch");
    const before = await readdir(scratchDir);
    expect(before.length).toBeGreaterThan(0);

    await handler.cleanup();

    // Directory should be gone
    const exists = await readdir(scratchDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("cleanup is safe to call when no scratch exists", async () => {
    // Should not throw
    await handler.cleanup();
  });
});

describe("scratch file naming", () => {
  it("sanitizes tool name in filename", async () => {
    const output = "data ".repeat(2000);
    const result = await handler.processToolOutput("file/read:special", output);

    expect(result.scratchFile).toBeTruthy();
    // Should not contain unsafe characters in filename
    const filename = result.scratchFile!.split("/").pop()!;
    expect(filename).not.toContain("/");
    expect(filename).not.toContain(":");
    expect(filename).toMatch(/^file_read_special-\d+\.txt$/);
  });
});
