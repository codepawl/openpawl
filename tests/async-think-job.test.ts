import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncThinkJobStore } from "../src/think/job-store.js";
import { MAX_CONCURRENT_ASYNC_JOBS } from "../src/think/async-types.js";
import type { AsyncThinkJob } from "../src/think/async-types.js";

function makeJob(overrides: Partial<AsyncThinkJob> = {}): AsyncThinkJob {
  return {
    id: `athink_${Math.random().toString(36).slice(2, 10)}`,
    question: "test question",
    status: "queued",
    pid: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    error: null,
    result: null,
    notificationSent: false,
    briefedAt: null,
    autoSave: true,
    ...overrides,
  };
}

describe("async think job lifecycle", () => {
  let tmpDir: string;
  let store: AsyncThinkJobStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "athink-lifecycle-"));
    store = new AsyncThinkJobStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("job created with status queued", () => {
    const job = makeJob({ id: "athink_new" });
    store.save(job);
    const loaded = store.get("athink_new");
    expect(loaded!.status).toBe("queued");
    expect(loaded!.pid).toBeNull();
    expect(loaded!.startedAt).toBeNull();
  });

  it("job transitions queued → running → completed", () => {
    const job = makeJob({ id: "athink_lifecycle" });
    store.save(job);

    // Transition to running
    job.status = "running";
    job.pid = process.pid;
    job.startedAt = Date.now();
    store.save(job);

    let loaded = store.get("athink_lifecycle")!;
    expect(loaded.status).toBe("running");
    expect(loaded.pid).toBe(process.pid);

    // Transition to completed
    job.status = "completed";
    job.completedAt = Date.now();
    store.save(job);

    loaded = store.get("athink_lifecycle")!;
    expect(loaded.status).toBe("completed");
    expect(loaded.completedAt).toBeGreaterThan(0);
  });

  it("job transitions queued → running → failed", () => {
    const job = makeJob({ id: "athink_fail" });
    store.save(job);

    job.status = "running";
    job.pid = process.pid;
    job.startedAt = Date.now();
    store.save(job);

    job.status = "failed";
    job.error = "Something went wrong";
    job.completedAt = Date.now();
    store.save(job);

    const loaded = store.get("athink_fail")!;
    expect(loaded.status).toBe("failed");
    expect(loaded.error).toBe("Something went wrong");
  });

  it("max concurrent limit enforced at 3", () => {
    expect(MAX_CONCURRENT_ASYNC_JOBS).toBe(3);

    // Create 3 running jobs
    for (let i = 0; i < 3; i++) {
      store.save(makeJob({
        id: `athink_r${i}`,
        status: "running",
        pid: process.pid,
        startedAt: Date.now(),
      }));
    }

    expect(store.getRunningCount()).toBe(3);
  });

  it("cancel updates status correctly", () => {
    const job = makeJob({ id: "athink_cancel", status: "running", pid: process.pid });
    store.save(job);

    // Simulate cancel
    job.status = "cancelled";
    job.completedAt = Date.now();
    store.save(job);

    const loaded = store.get("athink_cancel")!;
    expect(loaded.status).toBe("cancelled");
    expect(loaded.completedAt).toBeGreaterThan(0);
  });

  it("autoSave flag is persisted", () => {
    const withSave = makeJob({ id: "athink_save", autoSave: true });
    const withoutSave = makeJob({ id: "athink_nosave", autoSave: false });
    store.save(withSave);
    store.save(withoutSave);

    expect(store.get("athink_save")!.autoSave).toBe(true);
    expect(store.get("athink_nosave")!.autoSave).toBe(false);
  });
});
