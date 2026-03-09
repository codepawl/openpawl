/**
 * Centralized CLI logger with colored output and visual hierarchy.
 * Uses picocolors; respects NO_COLOR and TTY.
 */

import pc from "picocolors";

const SEP = " | ";

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
  info(message: string): void {
    console.log(formatLineWithIcon("ℹ", "INFO", pc.cyan, message));
  },

  success(message: string): void {
    console.log(formatLineWithIcon("✅", "SUCCESS", pc.green, message));
  },

  warn(message: string): void {
    console.warn(formatLineWithIcon("⚠", "WARN", pc.yellow, message));
  },

  error(message: string): void {
    console.error(formatLineWithIcon("❌", "ERROR", pc.red, message));
  },

  agent(message: string): void {
    console.log(formatLineWithIcon("🤖", "BOT", pc.magenta, message));
  },

  /** Plain unstyled line (no timestamp). Use for help text or raw output. */
  plain(message: string): void {
    console.log(message);
  },

  /** Returns a plain line (timestamp | LEVEL | message) for appending to log files. */
  plainLine(level: "INFO" | "WARN" | "ERROR", message: string): string {
    return `${timestamp()}${SEP}${level.padEnd(8)}${SEP}${message}`;
  },
} as const;
