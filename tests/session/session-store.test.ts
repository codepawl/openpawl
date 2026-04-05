import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session/session-store.js";
import { Session } from "../../src/session/session.js";
import { createEmptySession } from "../../src/session/session-state.js";

describe("SessionStore", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-test-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("save creates session directory and state.json", async () => {
    const session = new Session(createEmptySession("/tmp/project"));
    const result = await store.save(session);

    expect(result.isOk()).toBe(true);

    const stateFile = path.join(tmpDir, session.id, "state.json");
    expect(existsSync(stateFile)).toBe(true);

    const raw = await readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.state.id).toBe(session.id);
  });

  it("save writes atomically (no .tmp file left)", async () => {
    const session = new Session(createEmptySession("/tmp/project"));
    await store.save(session);

    const tmpFile = path.join(tmpDir, session.id, "state.json.tmp");
    expect(existsSync(tmpFile)).toBe(false);
  });

  it("load returns correct session state", async () => {
    const state = createEmptySession("/tmp/project");
    const session = new Session(state);
    session.addMessage({ role: "user", content: "hello" });
    await store.save(session);

    const loadResult = await store.load(session.id);
    expect(loadResult.isOk()).toBe(true);
    if (loadResult.isOk()) {
      expect(loadResult.value.id).toBe(session.id);
      expect(loadResult.value.messages).toHaveLength(1);
      expect(loadResult.value.messages[0]!.content).toBe("hello");
    }
  });

  it("load returns err for non-existent session", async () => {
    const result = await store.load("nonexistent-id");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("load recovers from checkpoint when state.json is corrupted", async () => {
    const session = new Session(createEmptySession("/tmp/project"));
    session.addMessage({ role: "user", content: "from checkpoint" });
    await store.save(session);
    await store.saveCheckpoint(session);

    // Corrupt state.json
    const stateFile = path.join(tmpDir, session.id, "state.json");
    await writeFile(stateFile, "corrupted{{{{", "utf-8");

    const loadResult = await store.load(session.id);
    expect(loadResult.isOk()).toBe(true);
    if (loadResult.isOk()) {
      expect(loadResult.value.messages[0]!.content).toBe("from checkpoint");
    }
  });

  it("list returns items sorted by updatedAt desc", async () => {
    const s1 = new Session(createEmptySession("/tmp/a"));
    await store.save(s1);

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    const s2 = new Session(createEmptySession("/tmp/b"));
    s2.addMessage({ role: "user", content: "newer" });
    await store.save(s2);

    const listResult = await store.list({ sortBy: "updatedAt", sortOrder: "desc" });
    expect(listResult.isOk()).toBe(true);
    if (listResult.isOk()) {
      expect(listResult.value).toHaveLength(2);
      expect(listResult.value[0]!.id).toBe(s2.id);
    }
  });

  it("list filters by status", async () => {
    const s1 = new Session(createEmptySession("/tmp/a"));
    await store.save(s1);

    const s2 = new Session(createEmptySession("/tmp/b"));
    s2.setStatus("archived");
    await store.save(s2);

    const listResult = await store.list({ status: "archived" });
    expect(listResult.isOk()).toBe(true);
    if (listResult.isOk()) {
      expect(listResult.value).toHaveLength(1);
      expect(listResult.value[0]!.id).toBe(s2.id);
    }
  });

  it("delete removes directory and updates index", async () => {
    const session = new Session(createEmptySession("/tmp/project"));
    await store.save(session);

    const deleteResult = await store.delete(session.id);
    expect(deleteResult.isOk()).toBe(true);

    expect(existsSync(path.join(tmpDir, session.id))).toBe(false);

    const listResult = await store.list();
    expect(listResult.isOk()).toBe(true);
    if (listResult.isOk()) {
      expect(listResult.value).toHaveLength(0);
    }
  });

  it("saveCheckpoint writes checkpoint.json", async () => {
    const session = new Session(createEmptySession("/tmp/project"));
    await store.save(session);
    await store.saveCheckpoint(session);

    const cpFile = path.join(tmpDir, session.id, "checkpoint.json");
    expect(existsSync(cpFile)).toBe(true);
  });

  it("saveFileSnapshot copies file to snapshots/", async () => {
    const session = new Session(createEmptySession("/tmp/project"));
    await store.save(session);

    // Create a file to snapshot
    const srcFile = path.join(tmpDir, "source.ts");
    await writeFile(srcFile, "const x = 1;", "utf-8");

    const result = await store.saveFileSnapshot(session.id, srcFile);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toContain("snapshots");
      expect(result.value).toContain(".snap");
      expect(existsSync(result.value)).toBe(true);

      const content = await readFile(result.value, "utf-8");
      expect(content).toBe("const x = 1;");
    }
  });

  it("restoreFileSnapshot restores file from snapshot", async () => {
    const session = new Session(createEmptySession("/tmp/project"));
    await store.save(session);

    const srcFile = path.join(tmpDir, "original.ts");
    await writeFile(srcFile, "original content", "utf-8");

    const snapResult = await store.saveFileSnapshot(session.id, srcFile);
    expect(snapResult.isOk()).toBe(true);

    // Modify original
    await writeFile(srcFile, "modified content", "utf-8");

    // Restore from snapshot
    const restoreResult = await store.restoreFileSnapshot(session.id, snapResult._unsafeUnwrap(), srcFile);
    expect(restoreResult.isOk()).toBe(true);

    const restored = await readFile(srcFile, "utf-8");
    expect(restored).toBe("original content");
  });

  it("index.json stays in sync after save/delete/archive", async () => {
    const s1 = new Session(createEmptySession("/tmp/a"));
    const s2 = new Session(createEmptySession("/tmp/b"));

    await store.save(s1);
    await store.save(s2);

    let listResult = await store.list();
    expect(listResult._unsafeUnwrap()).toHaveLength(2);

    await store.delete(s1.id);
    listResult = await store.list();
    expect(listResult._unsafeUnwrap()).toHaveLength(1);
    expect(listResult._unsafeUnwrap()[0]!.id).toBe(s2.id);
  });

  it("file permissions are 0o600 for state files", async () => {
    // Skip on Windows where permissions work differently
    if (process.platform === "win32") return;

    const session = new Session(createEmptySession("/tmp/project"));
    await store.save(session);

    const stateFile = path.join(tmpDir, session.id, "state.json");
    const stats = await stat(stateFile);
    // Check owner read+write bits (0o600 = rw-------)
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("exists returns correct boolean", async () => {
    const session = new Session(createEmptySession("/tmp/project"));

    expect(await store.exists(session.id)).toBe(false);
    await store.save(session);
    expect(await store.exists(session.id)).toBe(true);
  });
});
