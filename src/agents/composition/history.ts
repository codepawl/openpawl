/**
 * CompositionHistoryStore — LanceDB persistence for composition history.
 * Follows the same patterns as ProfileStore in src/agents/profiles/store.ts.
 */

import type * as lancedb from "@lancedb/lancedb";
import type { CompositionHistoryEntry } from "./types.js";
import { logger, isDebugMode } from "../../core/logger.js";

const HISTORY_TABLE = "composition_history";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

interface HistoryRow {
  id: string;
  composition: string;
  overrides: string;
  goal: string;
  run_id: number;
  success: number;
  created_at: string;
  vector: number[];
}

function entryToRow(entry: CompositionHistoryEntry): HistoryRow {
  return {
    id: entry.id,
    composition: JSON.stringify(entry.composition),
    overrides: JSON.stringify(entry.overrides),
    goal: entry.goal,
    run_id: entry.runId,
    success: entry.success ? 1 : 0,
    created_at: entry.createdAt,
    vector: [0],
  };
}

function rowToEntry(row: Record<string, unknown>): CompositionHistoryEntry {
  let composition;
  try {
    composition = JSON.parse(String(row.composition ?? "{}"));
  } catch {
    composition = {};
  }

  let overrides;
  try {
    overrides = JSON.parse(String(row.overrides ?? "[]"));
  } catch {
    overrides = [];
  }

  return {
    id: String(row.id ?? ""),
    composition,
    overrides,
    goal: String(row.goal ?? ""),
    runId: Number(row.run_id ?? 0),
    success: Number(row.success ?? 0) === 1,
    createdAt: String(row.created_at ?? ""),
  };
}

export class CompositionHistoryStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  async init(db: lancedb.Connection): Promise<void> {
    this.db = db;
    try {
      const tableNames = await db.tableNames();
      if (tableNames.includes(HISTORY_TABLE)) {
        this.table = await db.openTable(HISTORY_TABLE);
      }
      log(`CompositionHistoryStore initialized (table exists: ${this.table !== null})`);
    } catch (err) {
      log(`CompositionHistoryStore init failed: ${err}`);
    }
  }

  async record(entry: CompositionHistoryEntry): Promise<boolean> {
    if (!this.db) return false;
    try {
      const row = entryToRow(entry);
      if (!this.table) {
        this.table = await this.db.createTable(HISTORY_TABLE, [row as unknown as Record<string, unknown>]);
      } else {
        await this.table.add([row as unknown as Record<string, unknown>]);
      }
      return true;
    } catch (err) {
      log(`Failed to record composition history: ${err}`);
      return false;
    }
  }

  async getRecent(limit = 10): Promise<CompositionHistoryEntry[]> {
    if (!this.table) return [];
    try {
      const rows = (await this.table.query().toArray()) as Array<Record<string, unknown>>;
      return rows
        .map(rowToEntry)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    } catch (err) {
      log(`Failed to get composition history: ${err}`);
      return [];
    }
  }
}
