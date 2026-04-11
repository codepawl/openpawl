/**
 * Centralized CLI logger with colored output and visual hierarchy.
 * Uses picocolors; respects NO_COLOR and TTY.
 */

import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";

const SEP = " | ";

let _debugMode = false;
let _muted = false;

export function setDebugMode(enabled: boolean): void {
  _debugMode = enabled;
}

export function isDebugMode(): boolean {
  return _debugMode;
}

/** Suppress all logger output (used during TUI mode). */
export function setLoggerMuted(muted: boolean): void {
  _muted = muted;
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function formatLineWithIcon(
  icon: string,
  levelLabel: string,
  levelColor: (s: string) => string,
  message: string
): string {
  const ts = pc.gray(timestamp());
  const sep = pc.gray(SEP);
  const body = levelColor(icon + " " + levelLabel + "  " + message);
  return `${ts}${sep}${body}`;
}

export const logger = {
  debug(message: string): void {
    if (_muted || !_debugMode) return;
    console.log(formatLineWithIcon("🔍", "DEBUG", pc.blue, message));
  },

  info(message: string): void {
    if (_muted) return;
    console.log(formatLineWithIcon("ℹ", "INFO", pc.cyan, message));
  },

  success(message: string): void {
    if (_muted) return;
    console.log(formatLineWithIcon("✅", "SUCCESS", pc.green, message));
  },

  warn(message: string): void {
    if (_muted) return;
    console.warn(formatLineWithIcon(ICONS.warning, "WARN", pc.yellow, message));
  },

  error(message: string): void {
    if (_muted) return;
    console.error(formatLineWithIcon("❌", "ERROR", pc.red, message));
  },

  agent(message: string): void {
    if (_muted || !_debugMode) return;
    console.log(formatLineWithIcon("🤖", "BOT", pc.magenta, message));
  },

  /** Plain unstyled line (no timestamp). Use for help text or raw output. */
  plain(message: string): void {
    if (_muted) return;
    console.log(message);
  },

  /** Returns a plain line (timestamp | LEVEL | message) for appending to log files. */
  plainLine(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string): string {
    return `${timestamp()}${SEP}${level.padEnd(8)}${SEP}${message}`;
  },
} as const;
