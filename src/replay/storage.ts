/**
 * Storage management for session recordings.
 * Handles compression, retention, pruning, and tagging.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, rmSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import type { SessionIndexEntry, RecordingEvent, BroadcastEvent } from "./types.js";

const SESSIONS_DIR = path.join(os.homedir(), ".teamclaw", "sessions");
const INDEX_FILE = path.join(SESSIONS_DIR, "index.json");
const DEFAULT_MAX_SESSIONS = 20;

export function getSessionsDir(): string {
  return SESSIONS_DIR;
}

export function getSessionDir(sessionId: string): string {
  return path.join(SESSIONS_DIR, sessionId);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Index CRUD
// ---------------------------------------------------------------------------

export function readSessionIndex(): SessionIndexEntry[] {
  if (!existsSync(INDEX_FILE)) return [];
  try {
    return JSON.parse(readFileSync(INDEX_FILE, "utf-8")) as SessionIndexEntry[];
  } catch {
    return [];
  }
}

export function writeSessionIndex(entries: SessionIndexEntry[]): void {
  ensureDir(SESSIONS_DIR);
  writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2), "utf-8");
}

export function addSessionToIndex(entry: SessionIndexEntry): void {
  const entries = readSessionIndex();
  const idx = entries.findIndex((e) => e.sessionId === entry.sessionId);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  writeSessionIndex(entries);
}

export function getSessionEntry(sessionId: string): SessionIndexEntry | null {
  return readSessionIndex().find((e) => e.sessionId === sessionId) ?? null;
}

export function removeSessionFromIndex(sessionId: string): boolean {
  const entries = readSessionIndex();
  const idx = entries.findIndex((e) => e.sessionId === sessionId);
  if (idx < 0) return false;
  entries.splice(idx, 1);
  writeSessionIndex(entries);
  return true;
}

// ---------------------------------------------------------------------------
// Recording file I/O
// ---------------------------------------------------------------------------

export function getRecordingPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "recording.jsonl");
}

export function getCompressedPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "recording.jsonl.gz");
}

export function getBroadcastPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "broadcasts.jsonl");
}

export function getCompressedBroadcastPath(sessionId: string): string {
  return path.join(getSessionDir(sessionId), "broadcasts.jsonl.gz");
}

/** Append a recording event line (async, non-blocking). */
export function appendRecordingEvent(sessionId: string, event: RecordingEvent): void {
  const dir = getSessionDir(sessionId);
  ensureDir(dir);
  const filePath = getRecordingPath(sessionId);
  const line = JSON.stringify(event) + "\n";
  // Fire-and-forget async append
  writeFile(filePath, line, { flag: "a" }).catch(() => {});
}

/** Append a broadcast event line (async, non-blocking). */
export function appendBroadcastEvent(sessionId: string, event: BroadcastEvent): void {
  const dir = getSessionDir(sessionId);
  ensureDir(dir);
  const filePath = getBroadcastPath(sessionId);
  const line = JSON.stringify(event) + "\n";
  writeFile(filePath, line, { flag: "a" }).catch(() => {});
}

/** Read all recording events from JSONL (uncompressed or compressed). */
export async function readRecordingEvents(sessionId: string): Promise<RecordingEvent[]> {
  const compressed = getCompressedPath(sessionId);
  const raw = getRecordingPath(sessionId);

  let content: string;
  if (existsSync(compressed)) {
    content = await decompressToString(compressed);
  } else if (existsSync(raw)) {
    content = await readFile(raw, "utf-8");
  } else {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RecordingEvent);
}

/** Read all broadcast events from JSONL (uncompressed or compressed). */
export async function readBroadcastEvents(sessionId: string): Promise<BroadcastEvent[]> {
  const compressed = getCompressedBroadcastPath(sessionId);
  const raw = getBroadcastPath(sessionId);

  let content: string;
  if (existsSync(compressed)) {
    content = await decompressToString(compressed);
  } else if (existsSync(raw)) {
    content = await readFile(raw, "utf-8");
  } else {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as BroadcastEvent);
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

async function decompressToString(gzPath: string): Promise<string> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  const input = createReadStream(gzPath);
  input.pipe(gunzip);
  for await (const chunk of gunzip) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Compress a JSONL file to .gz and remove the original. */
export async function compressFile(filePath: string): Promise<string> {
  const gzPath = filePath + ".gz";
  if (!existsSync(filePath)) return gzPath;

  await pipeline(
    createReadStream(filePath),
    createGzip({ level: 6 }),
    createWriteStream(gzPath),
  );
  unlinkSync(filePath);
  return gzPath;
}

/** Compress all JSONL files for a session after run completes. */
export async function compressSession(sessionId: string): Promise<void> {
  const recording = getRecordingPath(sessionId);
  const broadcasts = getBroadcastPath(sessionId);

  if (existsSync(recording)) await compressFile(recording);
  if (existsSync(broadcasts)) await compressFile(broadcasts);
}

/** Get file size of recording (compressed or raw). */
export function getRecordingSize(sessionId: string): number {
  const compressed = getCompressedPath(sessionId);
  const raw = getRecordingPath(sessionId);
  if (existsSync(compressed)) return statSync(compressed).size;
  if (existsSync(raw)) return statSync(raw).size;
  return 0;
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

export function tagSession(sessionId: string, label: string): boolean {
  const entries = readSessionIndex();
  const entry = entries.find((e) => e.sessionId === sessionId);
  if (!entry) return false;
  entry.tag = label;
  writeSessionIndex(entries);
  return true;
}

export function untagSession(sessionId: string): boolean {
  const entries = readSessionIndex();
  const entry = entries.find((e) => e.sessionId === sessionId);
  if (!entry) return false;
  delete entry.tag;
  writeSessionIndex(entries);
  return true;
}

// ---------------------------------------------------------------------------
// Retention / Pruning
// ---------------------------------------------------------------------------

/** Get configured max sessions from config, or default. */
function getMaxSessions(): number {
  try {
    const configPath = path.join(os.homedir(), ".teamclaw", "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const replay = config.replay as Record<string, unknown> | undefined;
      if (replay && typeof replay.maxSessions === "number") {
        return replay.maxSessions;
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_MAX_SESSIONS;
}

/** Prune oldest untagged sessions if over the max limit. */
export function pruneOldSessions(): { pruned: string[] } {
  const max = getMaxSessions();
  const entries = readSessionIndex();
  const pruned: string[] = [];

  // Sort by createdAt ascending (oldest first)
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt);

  while (sorted.length > max) {
    // Find oldest untagged
    const idx = sorted.findIndex((e) => !e.tag);
    if (idx < 0) break; // all remaining are tagged

    const entry = sorted[idx];
    sorted.splice(idx, 1);
    pruned.push(entry.sessionId);

    // Remove files
    const dir = getSessionDir(entry.sessionId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (pruned.length > 0) {
    writeSessionIndex(sorted);
  }

  return { pruned };
}

/** Delete all session recordings. Returns count deleted. */
export function deleteAllSessions(): number {
  const entries = readSessionIndex();
  let count = 0;

  for (const entry of entries) {
    const dir = getSessionDir(entry.sessionId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      count++;
    }
  }

  writeSessionIndex([]);
  return count;
}

/** Delete a single session. */
export function deleteSession(sessionId: string): boolean {
  const dir = getSessionDir(sessionId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  return removeSessionFromIndex(sessionId);
}

/** Export a session's recording as a single JSON object. */
export async function exportSession(sessionId: string): Promise<Record<string, unknown>> {
  const entry = getSessionEntry(sessionId);
  const events = await readRecordingEvents(sessionId);
  const broadcasts = await readBroadcastEvents(sessionId);

  return {
    session: entry,
    events,
    broadcasts,
    exportedAt: new Date().toISOString(),
  };
}
