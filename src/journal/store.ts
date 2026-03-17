/**
 * DecisionStore — LanceDB persistence for the decision journal.
 * Table: `decisions` in ~/.teamclaw/memory/global.db.
 */

import type * as lancedb from "@lancedb/lancedb";
import type { Decision } from "./types.js";
import { logger, isDebugMode } from "../core/logger.js";

const DECISIONS_TABLE = "decisions";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

interface DecisionRow {
  id: string;
  session_id: string;
  run_index: number;
  captured_at: number;
  topic: string;
  decision: string;
  reasoning: string;
  recommended_by: string;
  confidence: number;
  task_id: string;
  goal_context: string;
  tags: string;
  status: string;
  superseded_by: string;
  vector: number[];
}

function decisionToRow(d: Decision): DecisionRow {
  return {
    id: d.id,
    session_id: d.sessionId,
    run_index: d.runIndex,
    captured_at: d.capturedAt,
    topic: d.topic,
    decision: d.decision,
    reasoning: d.reasoning,
    recommended_by: d.recommendedBy,
    confidence: d.confidence,
    task_id: d.taskId,
    goal_context: d.goalContext,
    tags: JSON.stringify(d.tags),
    status: d.status,
    superseded_by: d.supersededBy ?? "",
    vector: d.embedding.length > 0 ? d.embedding : [0],
  };
}

function rowToDecision(row: Record<string, unknown>): Decision {
  let tags: string[] = [];
  try {
    tags = JSON.parse(String(row.tags ?? "[]"));
  } catch {
    tags = [];
  }

  return {
    id: String(row.id ?? ""),
    sessionId: String(row.session_id ?? ""),
    runIndex: Number(row.run_index ?? 0),
    capturedAt: Number(row.captured_at ?? 0),
    topic: String(row.topic ?? ""),
    decision: String(row.decision ?? ""),
    reasoning: String(row.reasoning ?? ""),
    recommendedBy: String(row.recommended_by ?? ""),
    confidence: Number(row.confidence ?? 0),
    taskId: String(row.task_id ?? ""),
    goalContext: String(row.goal_context ?? ""),
    tags,
    embedding: [],
    supersededBy: String(row.superseded_by ?? "") || undefined,
    status: (row.status as Decision["status"]) ?? "active",
  };
}

export class DecisionStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  async init(db: lancedb.Connection): Promise<void> {
    this.db = db;
    try {
      const tableNames = await db.tableNames();
      if (tableNames.includes(DECISIONS_TABLE)) {
        this.table = await db.openTable(DECISIONS_TABLE);
      }
      log(`DecisionStore initialized (table exists: ${this.table !== null})`);
    } catch (err) {
      log(`DecisionStore init failed: ${err}`);
    }
  }

  async upsert(decision: Decision): Promise<boolean> {
    if (!this.db) return false;
    try {
      const row = decisionToRow(decision);
      if (!this.table) {
        this.table = await this.db.createTable(
          DECISIONS_TABLE,
          [row as unknown as Record<string, unknown>],
        );
      } else {
        try {
          await this.table.delete(`id = '${decision.id.replace(/'/g, "''")}'`);
        } catch {
          // May not exist
        }
        await this.table.add([row as unknown as Record<string, unknown>]);
      }
      return true;
    } catch (err) {
      log(`Failed to upsert decision ${decision.id}: ${err}`);
      return false;
    }
  }

  async getById(id: string): Promise<Decision | null> {
    if (!this.table) return null;
    try {
      const rows = (await this.table.query().toArray()) as Array<Record<string, unknown>>;
      const match = rows.find((r) => String(r.id) === id);
      return match ? rowToDecision(match) : null;
    } catch (err) {
      log(`Failed to get decision ${id}: ${err}`);
      return null;
    }
  }

  async getAll(): Promise<Decision[]> {
    if (!this.table) return [];
    try {
      const rows = (await this.table.query().toArray()) as Array<Record<string, unknown>>;
      return rows.map(rowToDecision).sort((a, b) => b.capturedAt - a.capturedAt);
    } catch (err) {
      log(`Failed to get all decisions: ${err}`);
      return [];
    }
  }

  async getDecisionsBySession(sessionId: string): Promise<Decision[]> {
    const all = await this.getAll();
    return all.filter((d) => d.sessionId === sessionId);
  }

  async getRecentDecisions(days: number): Promise<Decision[]> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = await this.getAll();
    return all.filter((d) => d.capturedAt >= cutoff);
  }

  async searchDecisions(query: string, limit = 10): Promise<Decision[]> {
    const all = await this.getAll();
    const lowerQuery = query.toLowerCase();
    const terms = lowerQuery.split(/\s+/).filter(Boolean);

    return all
      .map((d) => {
        const searchable = `${d.topic} ${d.decision} ${d.reasoning} ${d.tags.join(" ")}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (searchable.includes(term)) score += 1;
        }
        return { decision: d, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.decision);
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    const old = await this.getById(oldId);
    if (!old) return;
    old.status = "superseded";
    old.supersededBy = newId;
    await this.upsert(old);
  }

  async markReconsidered(id: string): Promise<boolean> {
    const d = await this.getById(id);
    if (!d) return false;
    d.status = "reconsidered";
    return this.upsert(d);
  }

  async count(): Promise<number> {
    if (!this.table) return 0;
    try {
      return await this.table.countRows();
    } catch {
      return 0;
    }
  }
}
