import { describe, expect, test } from "vitest";
import path from "node:path";
import { resolveSafePath, SecurityError } from "../src/core/sandbox.js";

describe("sandbox.resolveSafePath", () => {
  test("treats absolute-like paths as workspace-rooted", () => {
    const ws = "./teamclaw-workspace";
    const out = resolveSafePath("/package.json", ws);
    const wsAbs = path.resolve(process.cwd(), ws);
    expect(out).toBe(path.join(wsAbs, "package.json"));
  });

  test("allows normal relative paths", () => {
    const ws = "./teamclaw-workspace";
    const out = resolveSafePath("sub/dir/file.txt", ws);
    const wsAbs = path.resolve(process.cwd(), ws);
    expect(out).toBe(path.join(wsAbs, "sub/dir/file.txt"));
  });

  test("blocks traversal escaping the workspace", () => {
    expect(() => resolveSafePath("../../etc/passwd", "./teamclaw-workspace")).toThrow(SecurityError);
  });

  test("blocks tricky traversal variants", () => {
    expect(() => resolveSafePath("sub/../..", "./teamclaw-workspace")).toThrow(SecurityError);
    expect(() => resolveSafePath("/../x", "./teamclaw-workspace")).toThrow(SecurityError);
  });
});

