/**
 * Global utilization aggregation — stores utilization history across sessions.
 * Uses a simple JSON file for portability (no LanceDB dependency for this table).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentUtilization, GlobalUtilizationEntry } from "./types.js";

const GLOBAL_DIR = path.join(os.homedir(), ".openpawl", "memory");
const STORE_FILE = path.join(GLOBAL_DIR, "utilization-history.json");

function ensureDir(): void {
  mkdirSync(GLOBAL_DIR, { recursive: true });
}

function readStore(): GlobalUtilizationEntry[] {
  if (!existsSync(STORE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(STORE_FILE, "utf-8")) as GlobalUtilizationEntry[];
  } catch {
    return [];
  }
}

function writeStore(entries: GlobalUtilizationEntry[]): void {
  ensureDir();
  writeFileSync(STORE_FILE, JSON.stringify(entries, null, 2), "utf-8");
}

/** Record utilization entries after a run completes. Async-safe, never blocks. */
export function recordUtilization(utilizations: AgentUtilization[]): void {
  try {
    const entries = readStore();

    for (const u of utilizations) {
      // Upsert by sessionId + runIndex + agentRole
      const idx = entries.findIndex(
        (e) => e.sessionId === u.sessionId && e.runIndex === u.runIndex && e.agentRole === u.agentRole,
      );

      const entry: GlobalUtilizationEntry = {
        agentRole: u.agentRole,
        sessionId: u.sessionId,
        runIndex: u.runIndex,
        recordedAt: Date.now(),
        utilizationPct: u.utilizationPct,
        bottleneckScore: u.bottleneckScore,
        averageConfidence: u.averageConfidence,
        tasksHandled: u.tasksHandled,
      };

      if (idx >= 0) {
        entries[idx] = entry;
      } else {
        entries.push(entry);
      }
    }

    writeStore(entries);
  } catch {
    // Never block — silently swallow errors
  }
}

/** Get all utilization history entries. */
export function getUtilizationHistory(): GlobalUtilizationEntry[] {
  return readStore();
}

/** Get entries filtered by time range (since N ms ago). */
export function getUtilizationSince(sinceMs: number): GlobalUtilizationEntry[] {
  const cutoff = Date.now() - sinceMs;
  return readStore().filter((e) => e.recordedAt >= cutoff);
}

/** Get entries for a specific agent role. */
export function getUtilizationByAgent(agentRole: string): GlobalUtilizationEntry[] {
  return readStore().filter((e) => e.agentRole === agentRole);
}

/** Get entries for a specific session. */
export function getUtilizationBySession(sessionId: string): GlobalUtilizationEntry[] {
  return readStore().filter((e) => e.sessionId === sessionId);
}

/** Parse a duration string like "30d", "7d", "24h" to milliseconds. */
export function parseSinceDuration(since: string): number {
  const match = since.match(/^(\d+)([dhm])$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000; // default 30d

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "d": return value * 24 * 60 * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "m": return value * 60 * 1000;
    default: return 30 * 24 * 60 * 60 * 1000;
  }
}
