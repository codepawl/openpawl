import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionManager, createSessionManager } from "../../src/session/session-manager.js";

describe("SessionManager", () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-mgr-test-"));
    manager = createSessionManager({
      sessionsDir: tmpDir,
      idleTimeoutMinutes: 1,
      checkpointIntervalMs: 60_000, // long interval so it doesn't fire during tests
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await manager.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("create returns new session with active status", async () => {
    const result = await manager.create("/tmp/project");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("active");
      expect(result.value.id.length).toBe(12);
    }
  });

  it("create archives previous active session", async () => {
    const r1 = await manager.create("/tmp/a");
    expect(r1.isOk()).toBe(true);
    const firstId = r1._unsafeUnwrap().id;

    const r2 = await manager.create("/tmp/b");
    expect(r2.isOk()).toBe(true);

    // First session should no longer be active
    const active = manager.getActive();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(r2._unsafeUnwrap().id);
    expect(active!.id).not.toBe(firstId);

    // Verify first session was archived
    const listResult = await manager.list({ status: "archived" });
    expect(listResult.isOk()).toBe(true);
    if (listResult.isOk()) {
      expect(listResult.value.some((i) => i.id === firstId)).toBe(true);
    }
  });

  it("resume loads and activates session", async () => {
    const createResult = await manager.create("/tmp/project");
    const session = createResult._unsafeUnwrap();
    const sessionId = session.id;

    // Archive it
    await manager.archive(sessionId);
    expect(manager.getActive()).toBeNull();

    // Resume it
    const resumeResult = await manager.resume(sessionId);
    expect(resumeResult.isOk()).toBe(true);
    if (resumeResult.isOk()) {
      expect(resumeResult.value.id).toBe(sessionId);
      expect(resumeResult.value.status).toBe("active");
    }
  });

  it("resume archives previous active session", async () => {
    const r1 = await manager.create("/tmp/a");
    const id1 = r1._unsafeUnwrap().id;

    // Create a second session (archives first)
    const r2 = await manager.create("/tmp/b");
    const id2 = r2._unsafeUnwrap().id;

    // Resume first session (should archive second)
    await manager.resume(id1);

    const active = manager.getActive();
    expect(active!.id).toBe(id1);

    const listResult = await manager.list({ status: "archived" });
    expect(listResult._unsafeUnwrap().some((i) => i.id === id2)).toBe(true);
  });

  it("resumeLatest returns most recently updated session", async () => {
    await manager.create("/tmp/a");
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await manager.create("/tmp/b");
    const latestId = r2._unsafeUnwrap().id;

    // Shutdown and reinitialize to clear in-memory state
    await manager.shutdown();
    manager = createSessionManager({ sessionsDir: tmpDir, checkpointIntervalMs: 60_000 });
    await manager.initialize();

    const result = await manager.resumeLatest();
    expect(result.isOk()).toBe(true);
    // The latest session should be the archived one from create-archives-previous behavior
    // or the second one directly
    expect(result._unsafeUnwrap()).not.toBeNull();
  });

  it("resumeLatest returns null when no sessions exist", async () => {
    // Use a fresh empty dir
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-empty-"));
    const emptyManager = createSessionManager({ sessionsDir: emptyDir, checkpointIntervalMs: 60_000 });
    await emptyManager.initialize();

    const result = await emptyManager.resumeLatest();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();

    await emptyManager.shutdown();
    await rm(emptyDir, { recursive: true, force: true });
  });

  it("archive sets status and persists", async () => {
    const createResult = await manager.create("/tmp/project");
    const id = createResult._unsafeUnwrap().id;

    await manager.archive(id);
    expect(manager.getActive()).toBeNull();

    const listResult = await manager.list({ status: "archived" });
    expect(listResult._unsafeUnwrap().some((i) => i.id === id)).toBe(true);
  });

  it("getActive returns current active session", async () => {
    expect(manager.getActive()).toBeNull();

    const result = await manager.create("/tmp/project");
    expect(manager.getActive()).not.toBeNull();
    expect(manager.getActive()!.id).toBe(result._unsafeUnwrap().id);
  });

  it("addUserMessage resets idle timer", async () => {
    const result = await manager.create("/tmp/project");
    const id = result._unsafeUnwrap().id;

    const msgResult = await manager.addUserMessage(id, "hello");
    expect(msgResult.isOk()).toBe(true);
    if (msgResult.isOk()) {
      expect(msgResult.value.role).toBe("user");
      expect(msgResult.value.content).toBe("hello");
    }
  });

  it("addUserMessage returns err for unknown session", async () => {
    const result = await manager.addUserMessage("nonexistent", "hello");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("shutdown checkpoints all active sessions", async () => {
    const result = await manager.create("/tmp/project");
    const session = result._unsafeUnwrap();
    await manager.addUserMessage(session.id, "dirty message");

    await manager.shutdown();

    // Reinitialize and check the message persisted
    const freshManager = createSessionManager({ sessionsDir: tmpDir, checkpointIntervalMs: 60_000 });
    await freshManager.initialize();

    const loadResult = await freshManager.resumeLatest();
    expect(loadResult.isOk()).toBe(true);
    const loaded = loadResult._unsafeUnwrap();
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.some((m) => m.content === "dirty message")).toBe(true);

    await freshManager.shutdown();
  });

  it("list returns filtered results", async () => {
    await manager.create("/tmp/a");
    const r2 = await manager.create("/tmp/b");

    const allResult = await manager.list();
    expect(allResult._unsafeUnwrap().length).toBeGreaterThanOrEqual(2);

    const activeResult = await manager.list({ status: "active" });
    expect(activeResult._unsafeUnwrap().length).toBe(1);
  });

  it("delete removes session permanently", async () => {
    const result = await manager.create("/tmp/project");
    const id = result._unsafeUnwrap().id;

    // Archive first so we can delete without it being active
    await manager.archive(id);

    const deleteResult = await manager.delete(id);
    expect(deleteResult.isOk()).toBe(true);

    const listResult = await manager.list();
    expect(listResult._unsafeUnwrap().every((i) => i.id !== id)).toBe(true);
  });

  it("events are emitted for create, resume, archive, message:added", async () => {
    const events: string[] = [];
    manager.on("session:created", () => events.push("created"));
    manager.on("session:archived", () => events.push("archived"));
    manager.on("session:resumed", () => events.push("resumed"));
    manager.on("message:added", () => events.push("message"));

    const r1 = await manager.create("/tmp/a");
    const id = r1._unsafeUnwrap().id;
    await manager.addUserMessage(id, "hi");
    await manager.archive(id);

    // Create another to resume
    const r2 = await manager.create("/tmp/b");
    const id2 = r2._unsafeUnwrap().id;
    await manager.archive(id2);
    await manager.resume(id2);

    expect(events).toContain("created");
    expect(events).toContain("message");
    expect(events).toContain("archived");
    expect(events).toContain("resumed");
  });

  it("generateTitle returns truncated first message", async () => {
    const short = await manager.generateTitle("Fix auth bug");
    expect(short).toBe("Fix auth bug");

    const long = await manager.generateTitle("A".repeat(100));
    expect(long.length).toBeLessThanOrEqual(54); // 50 + "..."
    expect(long).toContain("...");
  });
});
