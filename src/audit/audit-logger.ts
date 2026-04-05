/**
 * Append-only JSONL audit logger with rotation.
 */

import { createWriteStream, existsSync, statSync, renameSync, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ToolAuditEntry as AuditEntry } from "./tool-audit-types.js";
import { redactCredentials } from "../credentials/masking.js";

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 5;

export class AuditLogger {
  private logPath: string;
  private stream: WriteStream | null = null;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private entryCount = 0;

  constructor(logDir?: string) {
    const dir = logDir ?? path.join(os.homedir(), ".openpawl");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.logPath = path.join(dir, "audit.jsonl");
  }

  async log(entry: AuditEntry): Promise<void> {
    // Redact credentials from summaries
    const sanitized = {
      ...entry,
      inputSummary: redactCredentials(entry.inputSummary.slice(0, 500)),
      outputSummary: redactCredentials(entry.outputSummary.slice(0, 500)),
    };

    const line = JSON.stringify(sanitized) + "\n";
    this.buffer.push(line);
    this.entryCount++;

    // Flush every 100 entries
    if (this.buffer.length >= 100) {
      await this.flush();
    }

    // Start periodic flush if not running
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => void this.flush(), 5000);
      if (this.flushTimer.unref) this.flushTimer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    await this.rotateIfNeeded();

    if (!this.stream) {
      this.stream = createWriteStream(this.logPath, { flags: "a", mode: 0o600 });
    }

    const data = this.buffer.join("");
    this.buffer = [];

    return new Promise((resolve) => {
      this.stream!.write(data, () => resolve());
    });
  }

  async rotateIfNeeded(): Promise<void> {
    if (!existsSync(this.logPath)) return;
    try {
      const stat = statSync(this.logPath);
      if (stat.size <= MAX_SIZE_BYTES) return;
    } catch { return; }

    // Close current stream
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    // Rotate files
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const from = i === 1 ? this.logPath : `${this.logPath}.${i - 1}`;
      const to = `${this.logPath}.${i}`;
      if (existsSync(from)) {
        try { renameSync(from, to); } catch { /* skip */ }
      }
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}
