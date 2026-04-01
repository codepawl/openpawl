/**
 * Tests for @file reference resolver.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFileRef } from "../../src/app/file-ref.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "teamclaw-fileref-test-"));
});

describe("resolveFileRef", () => {
  it("reads a text file and detects language", () => {
    writeFileSync(path.join(tmpDir, "hello.ts"), "export const x = 1;");
    const result = resolveFileRef("hello.ts", tmpDir);

    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.content).toBe("export const x = 1;");
      expect(result.language).toBe("typescript");
      expect(result.path).toBe("hello.ts");
    }
  });

  it("returns error for nonexistent file", () => {
    const result = resolveFileRef("missing.txt", tmpDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not found");
    }
  });

  it("returns error for directory", () => {
    mkdirSync(path.join(tmpDir, "subdir"));
    const result = resolveFileRef("subdir", tmpDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("directory");
    }
  });

  it("detects binary files", () => {
    writeFileSync(path.join(tmpDir, "binary.bin"), Buffer.from([0x00, 0x01, 0xff, 0x00]));
    const result = resolveFileRef("binary.bin", tmpDir);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("binary");
    }
  });

  it("detects language from extension", () => {
    writeFileSync(path.join(tmpDir, "app.py"), "print('hello')");
    const result = resolveFileRef("app.py", tmpDir);
    if (!("error" in result)) {
      expect(result.language).toBe("python");
    }
  });

  it("returns empty language for unknown extension", () => {
    writeFileSync(path.join(tmpDir, "data.xyz"), "content");
    const result = resolveFileRef("data.xyz", tmpDir);
    if (!("error" in result)) {
      expect(result.language).toBe("");
    }
  });
});
