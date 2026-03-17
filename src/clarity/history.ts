/**
 * Clarity history — persists clarity check results in global.db.
 * Tracks ignored issue types to learn user preferences.
 */

import type * as lancedb from "@lancedb/lancedb";
import type { ClarityHistoryEntry, ClarityIssueType } from "./types.js";
import { logger, isDebugMode } from "../core/logger.js";

const CLARITY_HISTORY_TABLE = "clarity_history";
const IGNORE_THRESHOLD = 5;

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

interface ClarityHistoryRow {
  id: string;
  session_id: string;
  original_goal: string;
  clarified_goal: string;
  clarity_score: number;
  issues_json: string;
  resolution: string;
  ignored_issue_types_json: string;
  recorded_at: number;
  vector: number[];
}

function entryToRow(entry: ClarityHistoryEntry, id: string): ClarityHistoryRow {
  return {
    id,
    session_id: entry.sessionId,
    original_goal: entry.originalGoal,
    clarified_goal: entry.clarifiedGoal ?? "",
    clarity_score: entry.clarityScore,
    issues_json: JSON.stringify(entry.issues),
    resolution: entry.resolution,
    ignored_issue_types_json: JSON.stringify(entry.ignoredIssueTypes),
    recorded_at: entry.recordedAt,
    vector: [0],
  };
}

function rowToEntry(row: Record<string, unknown>): ClarityHistoryEntry {
  let issues: ClarityHistoryEntry["issues"] = [];
  let ignoredIssueTypes: ClarityIssueType[] = [];

  try {
    issues = JSON.parse(String(row.issues_json ?? "[]"));
  } catch { issues = []; }

  try {
    ignoredIssueTypes = JSON.parse(String(row.ignored_issue_types_json ?? "[]"));
  } catch { ignoredIssueTypes = []; }

  return {
    sessionId: String(row.session_id ?? ""),
    originalGoal: String(row.original_goal ?? ""),
    clarifiedGoal: (row.clarified_goal as string) || undefined,
    clarityScore: Number(row.clarity_score ?? 0),
    issues,
    resolution: (row.resolution as ClarityHistoryEntry["resolution"]) ?? "proceeded",
    ignoredIssueTypes,
    recordedAt: Number(row.recorded_at ?? 0),
  };
}

export class ClarityHistoryStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  async init(db: lancedb.Connection): Promise<void> {
    this.db = db;
    try {
      const tableNames = await db.tableNames();
      if (tableNames.includes(CLARITY_HISTORY_TABLE)) {
        this.table = await db.openTable(CLARITY_HISTORY_TABLE);
      }
      log(`ClarityHistoryStore initialized (table exists: ${this.table !== null})`);
    } catch (err) {
      log(`ClarityHistoryStore init failed: ${err}`);
    }
  }

  async record(entry: ClarityHistoryEntry): Promise<boolean> {
    if (!this.db) return false;
    try {
      const id = `clarity-${entry.recordedAt}-${Math.random().toString(36).slice(2, 8)}`;
      const row = entryToRow(entry, id);
      if (!this.table) {
        this.table = await this.db.createTable(
          CLARITY_HISTORY_TABLE,
          [row as unknown as Record<string, unknown>],
        );
      } else {
        await this.table.add([row as unknown as Record<string, unknown>]);
      }
      return true;
    } catch (err) {
      log(`Failed to record clarity history: ${err}`);
      return false;
    }
  }

  async getAll(): Promise<ClarityHistoryEntry[]> {
    if (!this.table) return [];
    try {
      const rows = (await this.table.query().toArray()) as Array<Record<string, unknown>>;
      return rows.map(rowToEntry).sort((a, b) => b.recordedAt - a.recordedAt);
    } catch (err) {
      log(`Failed to get clarity history: ${err}`);
      return [];
    }
  }

  /**
   * Get issue types that the user has ignored >= IGNORE_THRESHOLD times.
   * These should be suppressed in future checks.
   */
  async getLearnedIgnores(): Promise<ClarityIssueType[]> {
    const all = await this.getAll();
    const ignoreCounts = new Map<ClarityIssueType, number>();

    for (const entry of all) {
      for (const issueType of entry.ignoredIssueTypes) {
        ignoreCounts.set(issueType, (ignoreCounts.get(issueType) ?? 0) + 1);
      }
    }

    const result: ClarityIssueType[] = [];
    for (const [type, count] of ignoreCounts) {
      if (count >= IGNORE_THRESHOLD) {
        result.push(type);
      }
    }

    return result;
  }
}
