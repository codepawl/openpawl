/**
 * Structured debug logger — opt-in via OPENPAWL_DEBUG=true.
 * Writes append-only JSONL to ~/.openpawl/debug/<mode>-<timestamp>.jsonl.
 * Zero overhead when disabled (all methods are no-ops).
 *
 * Log rotation: on startup, if > 50 log files exist, prune to 30.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────

export type DebugSource =
  | "router"
  | "tool"
  | "llm"
  | "memory"
  | "session"
  | "error"
  | "tui";

export type DebugLevel = "debug" | "info" | "warn" | "error";

export interface DebugLog {
  timestamp: string;
  level: DebugLevel;
  source: DebugSource;
  event: string;
  data?: Record<string, unknown>;
  duration?: number;
  error?: string;
}

// ── Truncation limits ──────────────────────────────────────────────────

export const TRUNCATION = {
  systemPrompt: 500,
  userMessage: 500,
  llmResponse: 1000,
  thinkingBlock: 500,
  toolArgs: 200,
  contextPassing: 300,
  lessonText: 200,
  decisionText: 200,
  driftConflict: 200,
  embeddingQuery: 200,
  postMortemLesson: 200,
  goalText: 200,
  shellCommand: 200,
  shellStderr: 200,
} as const;

/** Truncate a string to the given limit, appending a size note if truncated. */
export function truncateStr(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + ` [truncated: ${text.length} total chars]`;
}

// ── Module state ───────────────────────────────────────────────────────

const _enabled = !!process.env.OPENPAWL_DEBUG;
let _sessionId = "unknown";
let _fd: number | null = null;
let _logPath = "";
let _rotated = false;
let _signalHookInstalled = false;

// ── Sensitive key pattern ──────────────────────────────────────────────

const SENSITIVE_KEY =
  /key|token|secret|password|credential|authorization|api_key|apikey/i;

const MAX_STRING_LEN = 500;

// ── Sanitization ───────────────────────────────────────────────────────

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 5) return "[nested]";

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.length > MAX_STRING_LEN) {
      return `[truncated: ${value.length} chars]`;
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    if (value.length > 20) {
      return `[array: ${value.length} items]`;
    }
    return value.map((v) => sanitizeValue(v, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Only redact string values — numeric fields like `inputTokens`/`tokenCount`
      // match the key regex but are never secret. Redacting numbers destroyed
      // the token accounting we need for profiling.
      if (SENSITIVE_KEY.test(k) && typeof v === "string" && v.length > 0) {
        result[k] = "[redacted]";
      } else if (k === "content" && typeof v === "string" && v.length > 200) {
        result[k] = `[content: ${v.length} chars]`;
      } else {
        result[k] = sanitizeValue(v, depth + 1);
      }
    }
    return result;
  }

  return String(value);
}

function sanitize(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return sanitizeValue(data, 0) as Record<string, unknown>;
}

// ── Log rotation ───────────────────────────────────────────────────────

const MAX_LOG_FILES = 50;
const KEEP_LOG_FILES = 30;

function rotateIfNeeded(debugDir: string): void {
  if (_rotated) return;
  _rotated = true;

  try {
    const files = readdirSync(debugDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        mtime: statSync(join(debugDir, f)).mtimeMs,
      }))
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    if (files.length > MAX_LOG_FILES) {
      const toDelete = files.slice(0, files.length - KEEP_LOG_FILES);
      for (const f of toDelete) {
        try {
          unlinkSync(join(debugDir, f.name));
        } catch {
          // ignore individual file errors
        }
      }
      // Log rotation warning via console (not JSONL, since file not open yet)
      console.error(`[openpawl-debug] Cleaned ${toDelete.length} old debug logs`);
    }
  } catch {
    // rotation is non-critical
  }
}

// ── File management ────────────────────────────────────────────────────

function ensureOpen(): void {
  if (_fd !== null) return;

  const debugDir = join(homedir(), ".openpawl", "debug");
  mkdirSync(debugDir, { recursive: true });

  rotateIfNeeded(debugDir);

  _logPath = join(debugDir, `${_sessionId}.jsonl`);
  _fd = openSync(_logPath, "a");
  installSignalHook();
}

function installSignalHook(): void {
  if (_signalHookInstalled) return;
  _signalHookInstalled = true;

  const onSignal = (signal: NodeJS.Signals) => {
    if (_fd !== null) {
      try {
        const entry: DebugLog = {
          timestamp: new Date().toISOString(),
          level: "warn",
          source: "error",
          event: "process:signal_received",
          data: { signal },
        };
        appendFileSync(_fd, JSON.stringify(entry) + "\n");
        closeSync(_fd);
        _fd = null;
      } catch {
        // Must never crash during shutdown.
      }
    }
  };

  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

// ── Public API ─────────────────────────────────────────────────────────

/** Check if debug logging is enabled. */
export function isDebugEnabled(): boolean {
  return _enabled;
}

/**
 * Set the session ID used for the log filename. Call once per session.
 * Naming convention: <mode>-<ISO-timestamp>
 * e.g. sprint-2026-04-13T14-23-05
 */
export function setDebugSessionId(mode: string): void {
  if (!_enabled) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  _sessionId = `${mode}-${ts}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Get the current debug log file path (empty if not yet opened). */
export function getDebugLogPath(): string {
  return _logPath;
}

/**
 * Write a debug log entry. No-op when OPENPAWL_DEBUG is not set.
 * Each call appends one JSON line to the session log file.
 */
export function debugLog(
  level: DebugLevel,
  source: DebugSource,
  event: string,
  opts?: {
    data?: Record<string, unknown>;
    duration?: number;
    error?: string;
  },
): void {
  if (!_enabled) return;

  ensureOpen();

  const entry: DebugLog = {
    timestamp: new Date().toISOString(),
    level,
    source,
    event,
  };

  if (opts?.data) {
    entry.data = sanitize(opts.data);
  }
  if (opts?.duration !== undefined) {
    entry.duration = Math.round(opts.duration);
  }
  if (opts?.error) {
    entry.error =
      opts.error.length > MAX_STRING_LEN
        ? opts.error.slice(0, MAX_STRING_LEN) + "..."
        : opts.error;
  }

  try {
    appendFileSync(_fd!, JSON.stringify(entry) + "\n");
  } catch {
    // Debug logging must never crash the host process
  }
}

/** Flush and close the log file descriptor. */
export function closeDebugLog(): void {
  if (!_enabled || _fd === null) return;
  try {
    closeSync(_fd);
  } catch {
    // ignore
  }
  _fd = null;
}

/**
 * Lightweight heartbeat event for call sites wrapping long-running I/O
 * (e.g. LLM calls). A stall then manifests as a growing gap between
 * heartbeats rather than pure silence. No-op when debug is disabled.
 */
export function debugHeartbeat(
  source: DebugSource,
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!_enabled) return;
  debugLog("debug", source, event, { data });
}
