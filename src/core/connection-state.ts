/**
 * Connection state machine for provider status display.
 *
 * States:
 *   no_key     — no API key found in config or env (terminal until reconfigured)
 *   ready      — key found, no network check yet
 *   connecting — tier 2 background check in progress
 *   connected  — tier 2 succeeded
 *   auth_failed — tier 2 got 401/403
 *   offline    — tier 2 network error or timeout
 *   error      — tier 3 LLM call failed
 */

import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DOT_SYMBOL } from "../tui/components/status-indicator.js";
import { homedir } from "node:os";

export type ConnectionStatus =
  | "no_key"
  | "ready"
  | "connecting"
  | "connected"
  | "auth_failed"
  | "offline"
  | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  providerName: string;
}

type Listener = (state: ConnectionState) => void;

let _state: ConnectionState = { status: "no_key", providerName: "" };
const _listeners: Listener[] = [];

const _debugStartup = !!process.env.OPENPAWL_DEBUG_STARTUP;
const _startMs = Date.now();
const _debugLogPath = _debugStartup
  ? join(homedir(), ".openpawl", "debug-connection.log")
  : "";

if (_debugStartup) {
  try { writeFileSync(_debugLogPath, `[connection-state] started ${new Date().toISOString()}\n`); } catch {}
}

function _debugLog(msg: string): void {
  if (!_debugStartup) return;
  try { appendFileSync(_debugLogPath, msg + "\n"); } catch {}
}

/**
 * Priority map — higher value = more authoritative status.
 * A status can only be overwritten by an equal or higher priority,
 * preventing stale background checks from downgrading "connected".
 */
const STATUS_PRIORITY: Record<ConnectionStatus, number> = {
  no_key: 0,
  ready: 1,
  connecting: 2,
  offline: 3,
  auth_failed: 4,
  error: 5,
  connected: 6,
};

export function getConnectionState(): ConnectionState {
  return _state;
}

export function setConnectionState(state: ConnectionState, opts?: { force?: boolean }): void {
  const prev = _state.status;
  const next = state.status;

  // Don't allow downgrading from "connected" unless forced or a real failure
  if (
    !opts?.force &&
    prev === "connected" &&
    STATUS_PRIORITY[next]! < STATUS_PRIORITY[prev]!
  ) {
    if (_debugStartup) {
      const elapsed = Date.now() - _startMs;
      _debugLog(`[+${elapsed}ms] BLOCKED ${prev} → ${next}\n  ${new Error().stack?.split("\n").slice(1, 4).join("\n  ") ?? ""}`);
    }
    return;
  }

  if (_debugStartup) {
    const elapsed = Date.now() - _startMs;
    _debugLog(`[+${elapsed}ms] ${prev} → ${next}\n  ${new Error().stack?.split("\n").slice(1, 4).join("\n  ") ?? ""}`);
  }

  _state = state;
  for (const fn of _listeners) fn(state);
}

export function onConnectionChange(fn: Listener): () => void {
  _listeners.push(fn);
  return () => {
    const idx = _listeners.indexOf(fn);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

/** Status bar display info for each connection state. */
export function getStatusDisplay(status: ConnectionStatus): { text: string; colorKey: "green" | "red" | "yellow" | "blue" | "dim" } {
  switch (status) {
    case "no_key":      return { text: `${DOT_SYMBOL.empty} no API key`, colorKey: "red" };
    case "ready":       return { text: `${DOT_SYMBOL.filled} ready`, colorKey: "blue" };
    case "connecting":  return { text: `${DOT_SYMBOL.half} connecting\u2026`, colorKey: "dim" };
    case "connected":   return { text: `${DOT_SYMBOL.filled} connected`, colorKey: "green" };
    case "auth_failed": return { text: `${DOT_SYMBOL.filled} auth failed`, colorKey: "red" };
    case "offline":     return { text: `${DOT_SYMBOL.filled} offline`, colorKey: "yellow" };
    case "error":       return { text: `${DOT_SYMBOL.filled} error`, colorKey: "red" };
  }
}
