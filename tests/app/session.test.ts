/**
 * Tests for TUI session manager.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../../src/app/session.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "teamclaw-session-test-"));
});

describe("SessionManager", () => {
  it("creates session directory and JSONL file", () => {
    const session = new SessionManager(tmpDir);
    const dir = session.getSessionDir();
    const content = readFileSync(path.join(dir, "messages.jsonl"), "utf-8");
    expect(content).toContain('"type":"meta"');
    expect(content).toContain(session.getSessionId());
  });

  it("generates unique session IDs", () => {
    const s1 = new SessionManager(tmpDir);
    const s2 = new SessionManager(tmpDir);
    expect(s1.getSessionId()).not.toBe(s2.getSessionId());
  });

  it("appends entries as valid JSONL", () => {
    const session = new SessionManager(tmpDir);
    session.append({ role: "user", content: "hello" });
    session.append({ role: "system", content: "world" });

    const content = readFileSync(path.join(session.getSessionDir(), "messages.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3); // meta + 2 entries

    // Each line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const entry = JSON.parse(lines[1]!);
    expect(entry.role).toBe("user");
    expect(entry.content).toBe("hello");
    expect(entry.ts).toBeGreaterThan(0);
  });

  it("tracks stats correctly", () => {
    const session = new SessionManager(tmpDir);
    session.append({ role: "user", content: "test" });
    session.append({ role: "system", content: "reply" });
    session.append({ role: "user", content: "/work build auth" });

    const stats = session.getStats();
    expect(stats.messageCount).toBe(3);
    expect(stats.workRunCount).toBe(1);
    expect(stats.lastGoal).toBe("build auth");
  });

  it("close() writes end entry", () => {
    const session = new SessionManager(tmpDir);
    session.append({ role: "user", content: "test" });
    session.close();

    const content = readFileSync(path.join(session.getSessionDir(), "messages.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = JSON.parse(lines[lines.length - 1]!);
    expect(lastLine.type).toBe("end");
    expect(lastLine.stats).toBeDefined();
  });

  it("getRecent() returns recent sessions sorted by date", () => {
    new SessionManager(tmpDir);
    new SessionManager(tmpDir);
    new SessionManager(tmpDir);

    const recent = SessionManager.getRecent(10, tmpDir);
    expect(recent.length).toBe(3);
    // Most recent first
    expect(recent[0]!.startedAt).toBeGreaterThanOrEqual(recent[1]!.startedAt);
  });

  it("getRecent() returns empty array for nonexistent directory", () => {
    const recent = SessionManager.getRecent(10, "/nonexistent");
    expect(recent).toEqual([]);
  });
});
