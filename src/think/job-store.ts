/**
 * File-backed store for async think jobs.
 * Each job is a JSON file at ~/.teamclaw/think/<jobId>.json.
 * Uses atomic writes (tmp + rename) to prevent corruption.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AsyncThinkJob } from "./async-types.js";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class AsyncThinkJobStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? path.join(os.homedir(), ".teamclaw", "think");
  }

  ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  save(job: AsyncThinkJob): void {
    this.ensureDir();
    const filePath = path.join(this.dir, `${job.id}.json`);
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(job, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, filePath);
  }

  get(jobId: string): AsyncThinkJob | null {
    const filePath = path.join(this.dir, `${jobId}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as AsyncThinkJob;
    } catch {
      return null;
    }
  }

  list(): AsyncThinkJob[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".tmp"),
    );
    const jobs: AsyncThinkJob[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(path.join(this.dir, f), "utf-8");
        jobs.push(JSON.parse(raw) as AsyncThinkJob);
      } catch {
        // skip corrupt files
      }
    }
    this.detectOrphans(jobs);
    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  delete(jobId: string): boolean {
    const filePath = path.join(this.dir, `${jobId}.json`);
    if (!existsSync(filePath)) return false;
    rmSync(filePath, { force: true });
    return true;
  }

  getRunningCount(): number {
    return this.list().filter((j) => j.status === "running").length;
  }

  getCompleted(): AsyncThinkJob[] {
    return this.list().filter((j) => j.status === "completed");
  }

  getUnbriefed(): AsyncThinkJob[] {
    return this.list().filter(
      (j) => j.status === "completed" && j.briefedAt === null,
    );
  }

  markBriefed(jobId: string): void {
    const job = this.get(jobId);
    if (!job) return;
    job.briefedAt = Date.now();
    this.save(job);
  }

  clearFinished(): number {
    const jobs = this.list();
    let count = 0;
    for (const job of jobs) {
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        this.delete(job.id);
        count++;
      }
    }
    return count;
  }

  private detectOrphans(jobs: AsyncThinkJob[]): void {
    for (const job of jobs) {
      if (job.status === "running" && job.pid !== null) {
        if (!isPidAlive(job.pid)) {
          job.status = "failed";
          job.error = "Process exited unexpectedly (orphaned)";
          job.completedAt = Date.now();
          this.save(job);
        }
      }
    }
  }
}
