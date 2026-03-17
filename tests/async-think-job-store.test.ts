import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncThinkJobStore } from "../src/think/job-store.js";
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

describe("AsyncThinkJobStore", () => {
  let tmpDir: string;
  let store: AsyncThinkJobStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "athink-test-"));
    store = new AsyncThinkJobStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save/get round-trip", () => {
    const job = makeJob({ id: "athink_abc123" });
    store.save(job);
    const loaded = store.get("athink_abc123");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("athink_abc123");
    expect(loaded!.question).toBe("test question");
  });

  it("get returns null for missing job", () => {
    expect(store.get("nonexistent")).toBeNull();
  });

  it("list() returns sorted by createdAt desc", () => {
    const old = makeJob({ id: "athink_old", createdAt: 1000 });
    const mid = makeJob({ id: "athink_mid", createdAt: 2000 });
    const recent = makeJob({ id: "athink_new", createdAt: 3000 });
    store.save(mid);
    store.save(old);
    store.save(recent);

    const list = store.list();
    expect(list.map((j) => j.id)).toEqual(["athink_new", "athink_mid", "athink_old"]);
  });

  it("list() detects orphaned PIDs", () => {
    // Use a PID that definitely doesn't exist
    const job = makeJob({
      id: "athink_orphan",
      status: "running",
      pid: 999999999,
      startedAt: Date.now(),
    });
    store.save(job);

    const list = store.list();
    const orphan = list.find((j) => j.id === "athink_orphan");
    expect(orphan).toBeDefined();
    expect(orphan!.status).toBe("failed");
    expect(orphan!.error).toContain("orphaned");
  });

  it("delete removes job", () => {
    const job = makeJob({ id: "athink_del" });
    store.save(job);
    expect(store.get("athink_del")).not.toBeNull();
    const deleted = store.delete("athink_del");
    expect(deleted).toBe(true);
    expect(store.get("athink_del")).toBeNull();
  });

  it("delete returns false for missing job", () => {
    expect(store.delete("nonexistent")).toBe(false);
  });

  it("clearFinished() removes completed/failed/cancelled, keeps running/queued", () => {
    store.save(makeJob({ id: "athink_q", status: "queued" }));
    store.save(makeJob({ id: "athink_r", status: "running", pid: process.pid }));
    store.save(makeJob({ id: "athink_c", status: "completed" }));
    store.save(makeJob({ id: "athink_f", status: "failed" }));
    store.save(makeJob({ id: "athink_x", status: "cancelled" }));

    const count = store.clearFinished();
    expect(count).toBe(3);

    const remaining = store.list();
    expect(remaining.map((j) => j.id).sort()).toEqual(["athink_q", "athink_r"]);
  });

  it("getUnbriefed() returns only completed without briefedAt", () => {
    store.save(makeJob({ id: "athink_ub1", status: "completed", briefedAt: null }));
    store.save(makeJob({ id: "athink_ub2", status: "completed", briefedAt: Date.now() }));
    store.save(makeJob({ id: "athink_ub3", status: "running", pid: process.pid, briefedAt: null }));

    const unbriefed = store.getUnbriefed();
    expect(unbriefed).toHaveLength(1);
    expect(unbriefed[0].id).toBe("athink_ub1");
  });

  it("markBriefed() sets timestamp", () => {
    const job = makeJob({ id: "athink_brief", status: "completed" });
    store.save(job);
    expect(store.get("athink_brief")!.briefedAt).toBeNull();

    store.markBriefed("athink_brief");
    const updated = store.get("athink_brief");
    expect(updated!.briefedAt).toBeGreaterThan(0);
  });

  it("getRunningCount() counts running jobs", () => {
    store.save(makeJob({ id: "athink_r1", status: "running", pid: process.pid }));
    store.save(makeJob({ id: "athink_r2", status: "running", pid: process.pid }));
    store.save(makeJob({ id: "athink_q1", status: "queued" }));
    store.save(makeJob({ id: "athink_c1", status: "completed" }));

    expect(store.getRunningCount()).toBe(2);
  });

  it("getCompleted() returns only completed jobs", () => {
    store.save(makeJob({ id: "athink_gc1", status: "completed" }));
    store.save(makeJob({ id: "athink_gc2", status: "running", pid: process.pid }));
    store.save(makeJob({ id: "athink_gc3", status: "completed" }));

    const completed = store.getCompleted();
    expect(completed).toHaveLength(2);
  });

  it("list() returns empty for nonexistent dir", () => {
    const emptyStore = new AsyncThinkJobStore("/nonexistent/path");
    expect(emptyStore.list()).toEqual([]);
  });
});
