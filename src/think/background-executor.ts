/**
 * Launches async think jobs as detached background processes.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { AsyncThinkJobStore } from "./job-store.js";
import { MAX_CONCURRENT_ASYNC_JOBS } from "./async-types.js";
import type { AsyncThinkJob } from "./async-types.js";

export interface LaunchResult {
  ok: boolean;
  job?: AsyncThinkJob;
  error?: string;
}

export async function launchAsyncThink(
  question: string,
  options?: { autoSave?: boolean },
): Promise<LaunchResult> {
  const store = new AsyncThinkJobStore();

  const running = store.getRunningCount();
  if (running >= MAX_CONCURRENT_ASYNC_JOBS) {
    return {
      ok: false,
      error: `Maximum ${MAX_CONCURRENT_ASYNC_JOBS} concurrent async jobs. Use "teamclaw think jobs" to check status.`,
    };
  }

  const jobId = `athink_${randomUUID().slice(0, 8)}`;
  const job: AsyncThinkJob = {
    id: jobId,
    question,
    status: "queued",
    pid: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    error: null,
    result: null,
    notificationSent: false,
    briefedAt: null,
    autoSave: options?.autoSave ?? true,
  };
  store.save(job);

  const cliPath = process.argv[1];
  if (!cliPath) {
    job.status = "failed";
    job.error = "Cannot resolve CLI path.";
    store.save(job);
    return { ok: false, error: job.error };
  }

  const logDir = path.join(os.homedir(), ".teamclaw", "think");
  store.ensureDir();
  const logPath = path.join(logDir, `${jobId}.log`);
  const logFd = openSync(logPath, "a");

  const child = spawn(process.execPath, [cliPath, "think-worker", jobId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: process.cwd(),
    env: { ...process.env },
  });
  child.unref();

  try {
    closeSync(logFd);
  } catch {
    // ignore
  }

  job.pid = child.pid ?? null;
  job.status = "running";
  job.startedAt = Date.now();
  store.save(job);

  return { ok: true, job };
}
