/**
 * ProfileStore — LanceDB persistence for agent performance profiles.
 * Follows the same patterns as GlobalMemoryManager in src/memory/global/store.ts.
 */

import type * as lancedb from "@lancedb/lancedb";
import type { AgentProfile, TaskTypeScore } from "./types.js";
import { logger, isDebugMode } from "../../core/logger.js";

const PROFILES_TABLE = "agent_profiles";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

interface ProfileRow {
  role: string;
  task_type_scores: string;
  overall_score: number;
  strengths: string;
  weaknesses: string;
  last_updated_at: number;
  total_tasks_completed: number;
  score_history: string;
  vector: number[];
}

function profileToRow(profile: AgentProfile): ProfileRow {
  return {
    role: profile.agentRole,
    task_type_scores: JSON.stringify(profile.taskTypeScores),
    overall_score: profile.overallScore,
    strengths: JSON.stringify(profile.strengths),
    weaknesses: JSON.stringify(profile.weaknesses),
    last_updated_at: profile.lastUpdatedAt,
    total_tasks_completed: profile.totalTasksCompleted,
    score_history: JSON.stringify(profile.scoreHistory),
    vector: [0],
  };
}

function rowToProfile(row: Record<string, unknown>): AgentProfile {
  let taskTypeScores: TaskTypeScore[] = [];
  try {
    taskTypeScores = JSON.parse(String(row.task_type_scores ?? "[]"));
  } catch {
    taskTypeScores = [];
  }

  let strengths: string[] = [];
  try {
    strengths = JSON.parse(String(row.strengths ?? "[]"));
  } catch {
    strengths = [];
  }

  let weaknesses: string[] = [];
  try {
    weaknesses = JSON.parse(String(row.weaknesses ?? "[]"));
  } catch {
    weaknesses = [];
  }

  let scoreHistory: number[] = [];
  try {
    scoreHistory = JSON.parse(String(row.score_history ?? "[]"));
  } catch {
    scoreHistory = [];
  }

  return {
    agentRole: String(row.role ?? ""),
    taskTypeScores,
    overallScore: Number(row.overall_score ?? 0),
    strengths,
    weaknesses,
    lastUpdatedAt: Number(row.last_updated_at ?? 0),
    totalTasksCompleted: Number(row.total_tasks_completed ?? 0),
    scoreHistory,
  };
}

export class ProfileStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  async init(db: lancedb.Connection): Promise<void> {
    this.db = db;
    try {
      const tableNames = await db.tableNames();
      if (tableNames.includes(PROFILES_TABLE)) {
        this.table = await db.openTable(PROFILES_TABLE);
      }
      log(`ProfileStore initialized (table exists: ${this.table !== null})`);
    } catch (err) {
      log(`ProfileStore init failed: ${err}`);
    }
  }

  async upsert(profile: AgentProfile): Promise<boolean> {
    if (!this.db) return false;
    try {
      const row = profileToRow(profile);

      if (!this.table) {
        this.table = await this.db.createTable(PROFILES_TABLE, [row as unknown as Record<string, unknown>]);
      } else {
        try {
          await this.table.delete(`role = '${profile.agentRole.replace(/'/g, "''")}'`);
        } catch {
          // May not exist yet
        }
        await this.table.add([row as unknown as Record<string, unknown>]);
      }
      return true;
    } catch (err) {
      log(`Failed to upsert profile for ${profile.agentRole}: ${err}`);
      return false;
    }
  }

  async getByRole(role: string): Promise<AgentProfile | null> {
    if (!this.table) return null;
    try {
      const rows = (await this.table.query().toArray()) as Array<Record<string, unknown>>;
      const match = rows.find((r) => String(r.role) === role);
      return match ? rowToProfile(match) : null;
    } catch (err) {
      log(`Failed to get profile for ${role}: ${err}`);
      return null;
    }
  }

  async getAll(): Promise<AgentProfile[]> {
    if (!this.table) return [];
    try {
      const rows = (await this.table.query().toArray()) as Array<Record<string, unknown>>;
      return rows.map(rowToProfile);
    } catch (err) {
      log(`Failed to get all profiles: ${err}`);
      return [];
    }
  }

  async delete(role: string): Promise<boolean> {
    if (!this.table) return false;
    try {
      await this.table.delete(`role = '${role.replace(/'/g, "''")}'`);
      return true;
    } catch (err) {
      log(`Failed to delete profile for ${role}: ${err}`);
      return false;
    }
  }
}
