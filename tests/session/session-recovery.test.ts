import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../../src/session/session-store.js";
import { SessionRecovery } from "../../src/session/session-recovery.js";
import { Session } from "../../src/session/session.js";
import { createEmptySession } from "../../src/session/session-state.js";

describe("SessionRecovery", () => {
  let tmpDir: string;
  let store: SessionStore;
  let recovery: SessionRecovery;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "openpawl-recovery-test-"));
    store = new SessionStore(tmpDir);
    recovery = new SessionRecovery(store);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detectCrashedSessions finds active sessions from before process start", async () => {
    // Create a session with updatedAt in the past
    const state = createEmptySession("/tmp/test");
    state.updatedAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    state.status = "active";
    const session = new Session(state);
    await store.save(session);

    const crashed = await recovery.detectCrashedSessions();
    expect(crashed).toHaveLength(1);
    expect(crashed[0]!.id).toBe(session.id);
  });

  it("detectCrashedSessions ignores archived sessions", async () => {
    const state = createEmptySession("/tmp/test");
    state.updatedAt = new Date(Date.now() - 60_000).toISOString();
    state.status = "archived";
    const session = new Session(state);
    await store.save(session);

    const crashed = await recovery.detectCrashedSessions();
    expect(crashed).toHaveLength(0);
  });

  it("recover loads from state.json successfully", async () => {
    const state = createEmptySession("/tmp/test");
    state.updatedAt = new Date(Date.now() - 60_000).toISOString();
    const session = new Session(state);
    session.addMessage({ role: "user", content: "before crash" });
    await store.save(session);

    const result = await recovery.recover(session.id);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("active");
      // Original message + recovery system message
      expect(result.value.messages.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("recover falls back to checkpoint.json when state.json is corrupt", async () => {
    const session = new Session(createEmptySession("/tmp/test"));
    session.addMessage({ role: "user", content: "checkpoint data" });
    await store.save(session);
    await store.saveCheckpoint(session);

    // Corrupt state.json
    const stateFile = path.join(tmpDir, session.id, "state.json");
    await writeFile(stateFile, "corrupt{{{", "utf-8");

    const result = await recovery.recover(session.id);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should have the original message from checkpoint + recovery message
      const msgs = result.value.messages;
      expect(msgs.some((m) => m.content === "checkpoint data")).toBe(true);
    }
  });

  it("recover cancels pending tool confirmations", async () => {
    const state = createEmptySession("/tmp/test");
    state.pendingConfirmations = [
      {
        executionId: "exec-1",
        toolName: "write_file",
        agentId: "agent-1",
        description: "Write to /tmp/foo",
        risk: "medium",
      },
    ];
    state.toolExecutions = [
      {
        id: "exec-1",
        toolName: "write_file",
        agentId: "agent-1",
        input: {},
        output: null,
        status: "pending",
        duration: 0,
        timestamp: new Date().toISOString(),
      },
    ];
    const session = new Session(state);
    await store.save(session);

    const result = await recovery.recover(session.id);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.getState().pendingConfirmations).toHaveLength(0);
    }
  });

  it("recover adds system recovery message", async () => {
    const session = new Session(createEmptySession("/tmp/test"));
    await store.save(session);

    const result = await recovery.recover(session.id);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const msgs = result.value.messages;
      const recoveryMsg = msgs.find((m) =>
        m.role === "system" && m.content.includes("recovered"),
      );
      expect(recoveryMsg).toBeDefined();
    }
  });

  it("recoverAll returns recovered and failed lists", async () => {
    // Create a recoverable session
    const state1 = createEmptySession("/tmp/a");
    state1.updatedAt = new Date(Date.now() - 60_000).toISOString();
    state1.status = "active";
    const s1 = new Session(state1);
    await store.save(s1);

    const { recovered, failed } = await recovery.recoverAll();
    expect(recovered).toContain(s1.id);
    expect(failed).toHaveLength(0);
  });

  it("recoverAll does not throw when individual recovery fails", async () => {
    // Create a session entry in index but with no actual files
    const state = createEmptySession("/tmp/test");
    state.updatedAt = new Date(Date.now() - 60_000).toISOString();
    state.status = "active";
    const session = new Session(state);
    await store.save(session);

    // Remove the session dir to cause recovery failure
    await rm(path.join(tmpDir, session.id), { recursive: true, force: true });

    // Should not throw
    const { recovered, failed } = await recovery.recoverAll();
    expect(recovered).toHaveLength(0);
    expect(failed).toHaveLength(1);
  });
});
