/**
 * KnownFilesRegistry — per-session accumulating index of files the crew
 * has touched, surfaced as a markdown block injected at task start.
 *
 * Spec §5.3: "Each task gets fresh context + known files block injection."
 * Spec §7.6 lists the v0.3 known-files registry (PR #84) on the preserve
 * list; that PR's code was deleted in the #99 cleanup, so this file is a
 * fresh implementation following the spec's contract:
 *
 *   - Per-session scope. Files accumulate across phases — a file added
 *     in phase 1 is still known in phase 5.
 *   - Most-recent summary wins on duplicate path (later writes shadow
 *     earlier ones).
 *   - `format()` returns a sorted markdown block. To keep the injected
 *     block bounded, entries are dropped (oldest first by insertion
 *     order) until the rendered block fits the configured token cap.
 *
 * Token estimation here is the same 4-chars-per-token heuristic used
 * elsewhere in the crew runtime (subagent-runner). Good enough for
 * pre-injection budgeting; the LLM-side count is what matters at the
 * boundary, and that's covered by the per-task token budget.
 */

import type { CrewTask } from "./types.js";

export const DEFAULT_KNOWN_FILES_TOKEN_CAP = 2_000;

interface Entry {
  path: string;
  summary: string;
  /** Monotonic insert order — used to drop the oldest first when capping. */
  added_at: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class KnownFilesRegistry {
  private entries = new Map<string, Entry>();
  private counter = 0;

  constructor(private readonly tokenCap: number = DEFAULT_KNOWN_FILES_TOKEN_CAP) {}

  /**
   * Add or overwrite a known file. The latest summary wins; the entry's
   * `added_at` is refreshed on overwrite so a refreshed entry survives
   * cap-eviction longer than truly stale entries.
   */
  add(path: string, summary: string): void {
    if (!path) return;
    const trimmed = summary.trim();
    this.entries.set(path, {
      path,
      summary: trimmed,
      added_at: ++this.counter,
    });
  }

  /**
   * Convenience ingestor — every file the task created or modified
   * becomes a known file. Per-task summary defaults to the task
   * description so future tasks know what was done; callers can override
   * by calling `add` directly with a richer summary.
   */
  addFromTaskResult(task: CrewTask): void {
    const fallbackSummary =
      task.description.length > 200
        ? task.description.slice(0, 197) + "..."
        : task.description;
    const seen = new Set<string>();
    for (const p of task.files_created) {
      if (seen.has(p)) continue;
      seen.add(p);
      this.add(p, `created by '${task.assigned_agent}': ${fallbackSummary}`);
    }
    for (const p of task.files_modified) {
      if (seen.has(p)) continue;
      seen.add(p);
      this.add(p, `modified by '${task.assigned_agent}': ${fallbackSummary}`);
    }
  }

  /**
   * Render as a markdown block sorted by path. If the rendered block
   * exceeds the token cap, evict the oldest entries (by insert order)
   * until it fits. Returns an empty string when the registry is empty.
   */
  format(): string {
    if (this.entries.size === 0) return "";

    // Drop oldest entries until the rendered block fits the cap.
    const sortedByAge = Array.from(this.entries.values()).sort(
      (a, b) => a.added_at - b.added_at,
    );
    let working = sortedByAge.slice();
    let block = renderBlock(working);
    while (working.length > 0 && estimateTokens(block) > this.tokenCap) {
      working = working.slice(1);
      block = renderBlock(working);
    }
    return block;
  }

  size(): number {
    return this.entries.size;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  clear(): void {
    this.entries.clear();
    this.counter = 0;
  }

  /** Snapshot the path list — diagnostics + per-phase diff helpers. */
  paths(): string[] {
    return Array.from(this.entries.keys()).sort();
  }
}

function renderBlock(entries: Entry[]): string {
  if (entries.length === 0) return "";
  const sortedByPath = entries.slice().sort((a, b) => a.path.localeCompare(b.path));
  const lines = ["## Known files"];
  for (const e of sortedByPath) {
    lines.push(`- \`${e.path}\`: ${e.summary}`);
  }
  return lines.join("\n");
}
