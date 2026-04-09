/**
 * Session index operations — high-level CRUD for the session registry.
 * Wraps storage.ts with business logic for session lifecycle.
 */

import type { SessionIndexEntry } from "./types.js";
import {
  readSessionIndex,
  addSessionToIndex,
  getRecordingSize,
  compressSession,
  pruneOldSessions,
} from "./storage.js";

/** Create a new session entry. Called when a work session starts. */
export function createSession(sessionId: string, goal: string, teamRoles: string[]): SessionIndexEntry {
  const entry: SessionIndexEntry = {
    sessionId,
    goal,
    createdAt: Date.now(),
    completedAt: 0,
    totalRuns: 0,
    averageConfidence: 0,
    recordingPath: "",
    recordingSizeBytes: 0,
    teamComposition: teamRoles,
  };
  addSessionToIndex(entry);
  return entry;
}

/** Finalize a session after all runs complete. Compresses and prunes. */
export async function finalizeSession(
  sessionId: string,
  stats: {
    totalRuns: number;
    averageConfidence: number;
  },
): Promise<void> {
  // Compress recordings
  await compressSession(sessionId);

  // Update index entry
  const entries = readSessionIndex();
  const entry = entries.find((e) => e.sessionId === sessionId);
  if (entry) {
    entry.completedAt = Date.now();
    entry.totalRuns = stats.totalRuns;
    entry.averageConfidence = stats.averageConfidence;
    entry.recordingSizeBytes = getRecordingSize(sessionId);
    addSessionToIndex(entry);
  }

  // Auto-prune old sessions
  pruneOldSessions();
}

/** List all sessions, most recent first. */
export function listSessions(limit?: number): SessionIndexEntry[] {
  const entries = readSessionIndex();
  const sorted = entries.sort((a, b) => b.createdAt - a.createdAt);
  if (limit && limit > 0) return sorted.slice(0, limit);
  return sorted;
}

/** Get a single session by ID. */
export function getSession(sessionId: string): SessionIndexEntry | null {
  return readSessionIndex().find((e) => e.sessionId === sessionId) ?? null;
}
