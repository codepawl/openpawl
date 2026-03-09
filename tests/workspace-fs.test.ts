import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { ensureWorkspaceDir, listDir, readTextFile, writeTextFile } from "../src/core/workspace-fs.js";
import { SecurityError } from "../src/core/sandbox.js";

describe("workspace-fs", () => {
  test("write/read/list within workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "teamclaw-ws-"));
    try {
      const ws = path.join(root, "ws");
      await ensureWorkspaceDir(ws);
      await writeTextFile("a/b/c.txt", "hello", { workspaceDir: ws, mkdirp: true });
      const txt = await readTextFile("a/b/c.txt", { workspaceDir: ws });
      expect(txt).toBe("hello");
      const items = await listDir("a/b", { workspaceDir: ws });
      expect(items).toContain("c.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("blocks escape attempts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "teamclaw-ws-"));
    try {
      const ws = path.join(root, "ws");
      await ensureWorkspaceDir(ws);
      await expect(readTextFile("../../etc/passwd", { workspaceDir: ws })).rejects.toBeInstanceOf(SecurityError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

