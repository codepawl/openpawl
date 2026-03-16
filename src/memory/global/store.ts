/**
 * GlobalMemoryManager — owns the global LanceDB at ~/.teamclaw/memory/global.db.
 * Reuses SuccessPatternStore via composition for pattern storage.
 */

import * as lancedb from "@lancedb/lancedb";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SuccessPatternStore } from "../success/store.js";
import type { HttpEmbeddingFunction } from "../../core/knowledge-base.js";
import { KnowledgeGraphStore } from "./knowledge-graph.js";
import type { GlobalFailureLesson, MemoryHealth } from "./types.js";
import { logger, isDebugMode } from "../../core/logger.js";

const LESSONS_TABLE = "global_failure_lessons";
const DEFAULT_DB_PATH = path.join(os.homedir(), ".teamclaw", "memory", "global.db");

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

export class GlobalMemoryManager {
  private readonly dbPath: string;
  private db: lancedb.Connection | null = null;
  private patternStore: SuccessPatternStore | null = null;
  private lessonsTable: lancedb.Table | null = null;
  private knowledgeGraph: KnowledgeGraphStore | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? DEFAULT_DB_PATH;
  }

  async init(embedder: HttpEmbeddingFunction): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await mkdir(dir, { recursive: true });
    this.db = await lancedb.connect(this.dbPath);
    this.patternStore = new SuccessPatternStore(this.db, embedder);
    await this.patternStore.init();

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(LESSONS_TABLE)) {
      this.lessonsTable = await this.db.openTable(LESSONS_TABLE);
    }
    this.knowledgeGraph = new KnowledgeGraphStore(this.db);
    await this.knowledgeGraph.init();
    log(`GlobalMemoryManager initialized at ${this.dbPath}`);
  }

  getDb(): lancedb.Connection | null {
    return this.db;
  }

  getPatternStore(): SuccessPatternStore | null {
    return this.patternStore;
  }

  getKnowledgeGraph(): KnowledgeGraphStore | null {
    return this.knowledgeGraph;
  }

  async upsertLesson(lesson: GlobalFailureLesson): Promise<boolean> {
    if (!this.db) return false;
    try {
      const row = {
        id: lesson.id,
        text: lesson.text,
        session_id: lesson.sessionId,
        retrieval_count: lesson.retrievalCount,
        helped_avoid_failure: lesson.helpedAvoidFailure ? 1 : 0,
        created_at: lesson.createdAt,
        promoted_at: lesson.promotedAt,
        promoted_by: lesson.promotedBy,
        vector: [0],
      };

      if (!this.lessonsTable) {
        this.lessonsTable = await this.db.createTable(LESSONS_TABLE, [row]);
      } else {
        try {
          await this.lessonsTable.delete(`id = '${lesson.id.replace(/'/g, "''")}'`);
        } catch {
          // May not exist
        }
        await this.lessonsTable.add([row]);
      }
      return true;
    } catch (err) {
      log(`Failed to upsert global lesson: ${err}`);
      return false;
    }
  }

  async searchLessons(_vector: number[], limit: number): Promise<GlobalFailureLesson[]> {
    if (!this.lessonsTable) return [];
    try {
      const rows = (await this.lessonsTable.query().limit(limit).toArray()) as Array<Record<string, unknown>>;
      return rows.map(rowToLesson);
    } catch (err) {
      log(`Failed to search global lessons: ${err}`);
      return [];
    }
  }

  async getAllLessons(): Promise<GlobalFailureLesson[]> {
    if (!this.lessonsTable) return [];
    try {
      const rows = (await this.lessonsTable.query().toArray()) as Array<Record<string, unknown>>;
      return rows.map(rowToLesson);
    } catch (err) {
      log(`Failed to get all global lessons: ${err}`);
      return [];
    }
  }

  async deleteLesson(id: string): Promise<boolean> {
    if (!this.lessonsTable) return false;
    try {
      await this.lessonsTable.delete(`id = '${id.replace(/'/g, "''")}'`);
      return true;
    } catch (err) {
      log(`Failed to delete global lesson ${id}: ${err}`);
      return false;
    }
  }

  async getLessonCount(): Promise<number> {
    if (!this.lessonsTable) return 0;
    try {
      return await this.lessonsTable.countRows();
    } catch {
      return 0;
    }
  }

  async getHealth(): Promise<MemoryHealth> {
    const patternCount = (await this.patternStore?.count()) ?? 0;
    const lessonCount = await this.getLessonCount();

    let avgAge = 0;
    let avgQuality = 0;
    let staleCount = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    if (patternCount > 0 && this.patternStore) {
      const patterns = await this.patternStore.getAll();
      const now = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      let totalAge = 0;
      let totalQuality = 0;

      for (const p of patterns) {
        const age = now - p.createdAt;
        totalAge += age;
        totalQuality += p.confidence;
        if (age > thirtyDaysMs) staleCount++;
        if (oldest === null || p.createdAt < oldest) oldest = p.createdAt;
        if (newest === null || p.createdAt > newest) newest = p.createdAt;
      }

      avgAge = totalAge / patterns.length;
      avgQuality = totalQuality / patterns.length;
    }

    return {
      totalGlobalPatterns: patternCount,
      totalGlobalLessons: lessonCount,
      averagePatternAge: avgAge,
      averageQualityScore: avgQuality,
      stalePatternsCount: staleCount,
      knowledgeGraphEdges: (await this.knowledgeGraph?.countEdges()) ?? 0,
      oldestPattern: oldest,
      newestPattern: newest,
    };
  }
}

function rowToLesson(row: Record<string, unknown>): GlobalFailureLesson {
  return {
    id: String(row.id ?? ""),
    text: String(row.text ?? ""),
    sessionId: String(row.session_id ?? ""),
    retrievalCount: Number(row.retrieval_count ?? 0),
    helpedAvoidFailure: Number(row.helped_avoid_failure ?? 0) === 1,
    createdAt: Number(row.created_at ?? 0),
    promotedAt: Number(row.promoted_at ?? 0),
    promotedBy: (row.promoted_by as "auto" | "user") ?? "auto",
  };
}
