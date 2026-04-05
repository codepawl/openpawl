/**
 * Process-level crash handler. Saves session state before exit.
 */

import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { redactCredentials } from "../credentials/masking.js";

const MAX_LOG_SIZE = 1_000_000; // 1MB
const EMERGENCY_SAVE_TIMEOUT_MS = 3000;

export class CrashHandler {
  private installed = false;
  private handlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  constructor(
    private sessionShutdown: () => Promise<void>,
  ) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;

    const crashHandler = (source: string) => (error: unknown) => {
      this.handleCrash(source, error);
    };

    const shutdownHandler = (signal: string) => () => {
      this.handleShutdown(signal);
    };

    const handlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [
      { event: "uncaughtException", handler: crashHandler("uncaughtException") },
      { event: "unhandledRejection", handler: crashHandler("unhandledRejection") },
      { event: "SIGINT", handler: shutdownHandler("SIGINT") },
      { event: "SIGTERM", handler: shutdownHandler("SIGTERM") },
    ];

    for (const { event, handler } of handlers) {
      process.on(event, handler);
    }
    this.handlers = handlers;
  }

  uninstall(): void {
    for (const { event, handler } of this.handlers) {
      process.off(event, handler);
    }
    this.handlers = [];
    this.installed = false;
  }

  private handleCrash(source: string, error: unknown): void {
    // 1. Log to crash file
    this.writeCrashLog(source, error);

    // 2. Emergency session save (3s timeout)
    const savePromise = Promise.race([
      this.sessionShutdown().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, EMERGENCY_SAVE_TIMEOUT_MS)),
    ]);

    // 3. Brief user message
    try {
      process.stderr.write(
        "\nOpenPawl crashed. Your session has been saved.\n" +
        "Run `openpawl` to resume where you left off.\n" +
        `Crash details: ~/.openpawl/crash.log\n\n`,
      );
    } catch {
      // stderr may be broken
    }

    // Wait for save then exit
    savePromise.finally(() => process.exit(1));
  }

  private handleShutdown(_signal: string): void {
    this.sessionShutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  }

  private writeCrashLog(source: string, error: unknown): void {
    try {
      const logDir = path.join(os.homedir(), ".openpawl");
      const logPath = path.join(logDir, "crash.log");

      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

      // Rotate if too large
      if (existsSync(logPath)) {
        try {
          const stat = statSync(logPath);
          if (stat.size > MAX_LOG_SIZE) {
            renameSync(logPath, logPath + ".old");
          }
        } catch { /* ignore */ }
      }

      const stack = error instanceof Error ? error.stack : String(error);
      const entry = [
        `[${new Date().toISOString()}] CRASH — ${source}`,
        `Error: ${redactCredentials(stack ?? "unknown")}`,
        "---\n",
      ].join("\n");

      appendFileSync(logPath, entry, "utf-8");
    } catch {
      // Never throw from crash handler
    }
  }
}
