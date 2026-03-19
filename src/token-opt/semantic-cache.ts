/**
 * Semantic cache — LanceDB-backed similarity cache for LLM responses.
 *
 * Checks prompt similarity BEFORE hitting the LLM. High threshold (0.92)
 * ensures only near-identical queries return cached results.
 *
 * Cache keys include agent role — a similar prompt from different agent
 * roles will NOT hit the same cache entry.
 *
 * Uses the same LanceDB global DB as the memory system.
 */

import * as lancedb from "@lancedb/lancedb";
import os from "node:os";
import path from "node:path";
import { HttpEmbeddingFunction } from "../core/knowledge-base.js";
import { hasSessionSpecificContent } from "../cache/cache-store.js";
import { recordSemanticCacheHit, recordSemanticCacheMiss } from "./stats.js";
import { logger } from "../core/logger.js";

const TABLE_NAME = "semantic_cache";
const SIMILARITY_THRESHOLD = 0.92;
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_EMBEDDING_BASE = "http://localhost:11434";

interface CacheRecord {
  id: string;
  role: string;
  model: string;
  response: string;
  created_at: number;
  expires_at: number;
  vector: number[];
}

export class SemanticCache {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private embedder: HttpEmbeddingFunction | null = null;
  private enabled = true;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const dbPath = path.join(os.homedir(), ".teamclaw", "memory", "global.db");
      this.db = await lancedb.connect(dbPath);
      this.embedder = new HttpEmbeddingFunction(DEFAULT_EMBEDDING_BASE, EMBEDDING_MODEL, "");

      // Test embedding service
      await this.embedder.generate(["test"]);

      const tableNames = await this.db.tableNames();
      if (tableNames.includes(TABLE_NAME)) {
        this.table = await this.db.openTable(TABLE_NAME);
      }
      // Table is created on first store() call
    } catch {
      logger.debug("[semantic-cache] Init failed — disabled for this session");
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return (
      this.enabled &&
      process.env.TEAMCLAW_NO_CACHE !== "true" &&
      process.env.TEAMCLAW_NO_SEMANTIC_CACHE !== "true"
    );
  }

  async lookup(prompt: string, model: string, agentRole: string): Promise<string | null> {
    if (!this.isEnabled() || !this.table || !this.embedder) return null;
    if (hasSessionSpecificContent(prompt)) return null;

    try {
      const [vector] = await this.embedder.generate([this.buildCacheInput(prompt, agentRole)]);
      if (!vector || vector.length === 0) return null;

      const now = Date.now();
      const results = await this.table
        .vectorSearch(vector)
        .limit(3)
        .toArray();

      for (const result of results) {
        const record = result as unknown as CacheRecord & { _distance?: number };
        // LanceDB returns L2 distance; convert to cosine similarity approximation
        // For normalized vectors: similarity ≈ 1 - distance/2
        const distance = record._distance ?? Infinity;
        const similarity = 1 - distance / 2;

        if (
          similarity >= SIMILARITY_THRESHOLD &&
          record.role === agentRole &&
          record.expires_at > now
        ) {
          recordSemanticCacheHit();
          return record.response;
        }
      }
    } catch {
      logger.debug("[semantic-cache] Lookup failed");
    }

    recordSemanticCacheMiss();
    return null;
  }

  async store(prompt: string, model: string, agentRole: string, response: string): Promise<void> {
    if (!this.isEnabled() || !this.db || !this.embedder) return;
    if (hasSessionSpecificContent(prompt)) return;

    try {
      const [vector] = await this.embedder.generate([this.buildCacheInput(prompt, agentRole)]);
      if (!vector || vector.length === 0) return;

      const now = Date.now();
      const record: CacheRecord = {
        id: `sc-${now}-${Math.random().toString(36).slice(2, 8)}`,
        role: agentRole,
        model,
        response,
        created_at: now,
        expires_at: now + TTL_MS,
        vector,
      };

      const recordObj = record as unknown as Record<string, unknown>;
      if (!this.table) {
        this.table = await this.db.createTable(TABLE_NAME, [recordObj]);
      } else {
        await this.table.add([recordObj]);
      }
    } catch {
      logger.debug("[semantic-cache] Store failed");
    }
  }

  /**
   * Build cache input by combining prompt with agent role.
   * This ensures same prompt from different roles has different embeddings.
   */
  private buildCacheInput(prompt: string, agentRole: string): string {
    return `[role:${agentRole}] ${prompt}`;
  }
}

// Lazy singleton
let instance: SemanticCache | null = null;

export function getSemanticCache(): SemanticCache {
  if (!instance) {
    instance = new SemanticCache();
  }
  return instance;
}

export function resetSemanticCache(): void {
  instance = null;
}
