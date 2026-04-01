/**
 * Session logging — unified log output + console redirect for debug capture.
 */

import { appendFile } from "node:fs/promises";
import { logger } from "../core/logger.js";

let debugLogPath = "";
let workHistoryLogPath = "";

/** Set log file paths for the current session. */
export function initLogPaths(sessionLog: string, historyLog: string): void {
  debugLogPath = sessionLog;
  workHistoryLogPath = historyLog;
}

/** Get the current debug log path (for external consumers). */
export function getDebugLogPath(): string {
  return debugLogPath;
}

/** Get the current work history log path. */
export function getWorkHistoryLogPath(): string {
  return workHistoryLogPath;
}

/** Unified logger that writes to both terminal and work history log file. */
export function log(level: "info" | "warn" | "error", msg: string): void {
  const levelUp = level.toUpperCase() as "INFO" | "WARN" | "ERROR";
  if (level === "info") logger.info(msg);
  else if (level === "warn") logger.warn(msg);
  else logger.error(msg);
  if (workHistoryLogPath) {
    appendFile(
      workHistoryLogPath,
      logger.plainLine(levelUp, msg) + "\n",
    ).catch(() => {});
  }
}

/**
 * Redirect console.log/warn/error to debug log file during execution of fn.
 * Used to capture LangGraph and provider output for debugging.
 */
export async function withConsoleRedirect<T>(fn: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const write = (level: string, args: unknown[]): void => {
    const line = `[${new Date().toISOString()}] ${level}: ${args
      .map((a) => String(a))
      .join(" ")}`;
    originalLog(line);
    if (debugLogPath) {
      appendFile(debugLogPath, line + "\n").catch(() => {});
    }
  };

  console.log = (...args: unknown[]) => write("INFO", args);
  console.warn = (...args: unknown[]) => write("WARN", args);
  console.error = (...args: unknown[]) => write("ERROR", args);

  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}
