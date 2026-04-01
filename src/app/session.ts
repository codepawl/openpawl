/**
 * TUI session manager — JSONL-based message persistence.
 * Sessions are stored at ~/.teamclaw/sessions/tui-<timestamp>/messages.jsonl
 */

import { mkdirSync, appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionEntry {
  ts: number;
  role: string;
  content: string;
  agentName?: string;
  meta?: Record<string, unknown>;
}

export interface SessionStats {
  sessionId: string;
  startedAt: number;
  messageCount: number;
  workRunCount: number;
  lastGoal?: string;
}

let sessionCounter = 0;

export class SessionManager {
  private sessionId: string;
  private sessionDir: string;
  private filePath: string;
  private messageCount = 0;
  private workRunCount = 0;
  private lastGoal?: string;
  private startedAt: number;

  constructor(sessionsDir?: string) {
    this.startedAt = Date.now();
    this.sessionId = `tui-${this.startedAt}-${++sessionCounter}`;
    const baseDir = sessionsDir ?? path.join(os.homedir(), ".teamclaw", "sessions");
    this.sessionDir = path.join(baseDir, this.sessionId);
    mkdirSync(this.sessionDir, { recursive: true });
    this.filePath = path.join(this.sessionDir, "messages.jsonl");

    // Write metadata as first line
    const meta = { type: "meta", sessionId: this.sessionId, startedAt: this.startedAt, cwd: process.cwd() };
    appendFileSync(this.filePath, JSON.stringify(meta) + "\n");
  }

  append(entry: Omit<SessionEntry, "ts">): void {
    const full: SessionEntry = { ts: Date.now(), ...entry };
    appendFileSync(this.filePath, JSON.stringify(full) + "\n");
    this.messageCount++;

    if (entry.role === "user" && entry.content.startsWith("/work ")) {
      this.workRunCount++;
      this.lastGoal = entry.content.slice(6).trim();
    }
  }

  getStats(): SessionStats {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      messageCount: this.messageCount,
      workRunCount: this.workRunCount,
      lastGoal: this.lastGoal,
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  close(): void {
    const endEntry = { type: "end", ts: Date.now(), stats: this.getStats() };
    try {
      appendFileSync(this.filePath, JSON.stringify(endEntry) + "\n");
    } catch {
      // Never fail on close
    }
  }

  /** List recent TUI sessions from the sessions directory. */
  static getRecent(limit = 10, sessionsDir?: string): Array<{ sessionId: string; startedAt: number; messageCount: number }> {
    const baseDir = sessionsDir ?? path.join(os.homedir(), ".teamclaw", "sessions");
    try {
      const dirs = readdirSync(baseDir)
        .filter((d) => d.startsWith("tui-"))
        .map((d) => {
          const fp = path.join(baseDir, d, "messages.jsonl");
          try {
            const first = readFileSync(fp, "utf-8").split("\n")[0];
            const meta = first ? JSON.parse(first) : {};
            const stat = statSync(fp);
            const lines = readFileSync(fp, "utf-8").split("\n").filter(Boolean).length;
            return { sessionId: d, startedAt: meta.startedAt ?? stat.mtimeMs, messageCount: lines - 1 };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b!.startedAt - a!.startedAt)
        .slice(0, limit) as Array<{ sessionId: string; startedAt: number; messageCount: number }>;
      return dirs;
    } catch {
      return [];
    }
  }
}
