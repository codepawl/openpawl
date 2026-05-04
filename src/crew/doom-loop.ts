/**
 * DoomLoopDetector — repeated-failure backstop per spec §6.1.
 *
 * Spec §6.1 mandates "extend fingerprint to include exit code" so that
 * a task hitting the same shell error three times in a row can be
 * blocked rather than burning further retries. The fingerprint is the
 * tuple `(agent_id, task_id, error_kind, exit_code)`. Identical
 * fingerprints reaching count 3 mark the task as blocked; the executor
 * then sets `task.status = "blocked"` and moves on.
 *
 * Per-task counters reset when the task's status moves to a terminal
 * good state (`completed`). Calling `reset(task_id)` on every
 * status-becomes-completed transition keeps counters from leaking
 * across distinct attempts that recycled an id.
 */

const TRIPLE_REPEAT_THRESHOLD = 3;

interface FingerprintCounts {
  /** Map fingerprint string → seen count. */
  counts: Map<string, number>;
}

export interface DoomLoopRecord {
  agent_id: string;
  task_id: string;
  error_kind: string;
  exit_code?: number;
}

function fingerprintOf(rec: DoomLoopRecord): string {
  const exit = rec.exit_code === undefined ? "x" : String(rec.exit_code);
  return `${rec.agent_id}|${rec.task_id}|${rec.error_kind}|${exit}`;
}

export class DoomLoopDetector {
  private byTask = new Map<string, FingerprintCounts>();

  record(rec: DoomLoopRecord): { blocked: boolean; count: number } {
    const fp = fingerprintOf(rec);
    let bucket = this.byTask.get(rec.task_id);
    if (!bucket) {
      bucket = { counts: new Map() };
      this.byTask.set(rec.task_id, bucket);
    }
    const next = (bucket.counts.get(fp) ?? 0) + 1;
    bucket.counts.set(fp, next);
    return { blocked: next >= TRIPLE_REPEAT_THRESHOLD, count: next };
  }

  /** Pure check — does any fingerprint for this task already meet the threshold? */
  shouldBlock(task_id: string): boolean {
    const bucket = this.byTask.get(task_id);
    if (!bucket) return false;
    for (const count of bucket.counts.values()) {
      if (count >= TRIPLE_REPEAT_THRESHOLD) return true;
    }
    return false;
  }

  /** Reset counters for a single task — call when the task completes. */
  reset(task_id: string): void {
    this.byTask.delete(task_id);
  }

  /** Diagnostics. */
  countOf(rec: DoomLoopRecord): number {
    const bucket = this.byTask.get(rec.task_id);
    if (!bucket) return 0;
    return bucket.counts.get(fingerprintOf(rec)) ?? 0;
  }
}
