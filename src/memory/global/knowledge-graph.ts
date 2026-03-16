/**
 * KnowledgeGraphStore — tracks relationships between global patterns.
 * Uses LanceDB table for persistence, pure vector math for similarity.
 */

import { randomUUID } from "node:crypto";
import type * as lancedb from "@lancedb/lancedb";
import type { KnowledgeEdge, KnowledgeRelationship, GlobalSuccessPattern } from "./types.js";
import type { HttpEmbeddingFunction } from "../../core/knowledge-base.js";
import { logger, isDebugMode } from "../../core/logger.js";

const TABLE_NAME = "global_knowledge_graph";
const MAX_PATTERNS_FOR_REBUILD = 500;
const SIMILARITY_THRESHOLD = 0.85;

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

export class KnowledgeGraphStore {
  private readonly db: lancedb.Connection;
  private table: lancedb.Table | null = null;

  constructor(db: lancedb.Connection) {
    this.db = db;
  }

  async init(): Promise<void> {
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }
  }

  async addEdge(edge: KnowledgeEdge): Promise<boolean> {
    try {
      const row = edgeToRow(edge);
      if (!this.table) {
        this.table = await this.db.createTable(TABLE_NAME, [row]);
      } else {
        try {
          await this.table.delete(`id = '${edge.id.replace(/'/g, "''")}'`);
        } catch {
          // May not exist
        }
        await this.table.add([row]);
      }
      return true;
    } catch (err) {
      log(`Failed to add knowledge edge: ${err}`);
      return false;
    }
  }

  async getEdges(nodeId?: string): Promise<KnowledgeEdge[]> {
    if (!this.table) return [];
    try {
      const rows = (await this.table.query().toArray()) as Array<Record<string, unknown>>;
      const edges = rows.map(rowToEdge);
      if (!nodeId) return edges;
      return edges.filter((e) => e.fromPatternId === nodeId || e.toPatternId === nodeId);
    } catch (err) {
      log(`Failed to get edges: ${err}`);
      return [];
    }
  }

  async deleteEdge(id: string): Promise<boolean> {
    if (!this.table) return false;
    try {
      await this.table.delete(`id = '${id.replace(/'/g, "''")}'`);
      return true;
    } catch (err) {
      log(`Failed to delete edge: ${err}`);
      return false;
    }
  }

  async getGraph(maxNodes = 200): Promise<{ nodes: string[]; edges: KnowledgeEdge[] }> {
    const edges = await this.getEdges();
    const nodeSet = new Set<string>();
    for (const e of edges) {
      nodeSet.add(e.fromPatternId);
      nodeSet.add(e.toPatternId);
      if (nodeSet.size >= maxNodes) break;
    }
    const nodes = Array.from(nodeSet).slice(0, maxNodes);
    const filteredEdges = edges.filter(
      (e) => nodes.includes(e.fromPatternId) && nodes.includes(e.toPatternId),
    );
    return { nodes, edges: filteredEdges };
  }

  async countEdges(): Promise<number> {
    if (!this.table) return 0;
    try {
      return await this.table.countRows();
    } catch {
      return 0;
    }
  }

  async rebuildEdges(
    patterns: GlobalSuccessPattern[],
    embedder: HttpEmbeddingFunction,
  ): Promise<number> {
    if (patterns.length > MAX_PATTERNS_FOR_REBUILD) {
      log(`Short-circuit: ${patterns.length} patterns exceed rebuild limit of ${MAX_PATTERNS_FOR_REBUILD}`);
      return 0;
    }

    if (patterns.length < 2) return 0;

    // Generate embeddings for all patterns
    const texts = patterns.map(
      (p) => `${p.taskDescription} ${p.approach} ${p.goalContext}`,
    );
    const vectors = await embedder.generate(texts);
    if (vectors.length !== patterns.length) return 0;

    let newEdges = 0;

    // Build similar_to edges via cosine similarity
    for (let i = 0; i < patterns.length; i++) {
      for (let j = i + 1; j < patterns.length; j++) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        if (sim >= SIMILARITY_THRESHOLD) {
          const edge: KnowledgeEdge = {
            id: `edge-${randomUUID()}`,
            fromPatternId: patterns[i].id,
            toPatternId: patterns[j].id,
            relationship: "similar_to",
            strength: sim,
            observedCount: 1,
            createdAt: Date.now(),
          };
          await this.addEdge(edge);
          newEdges++;
        }
      }
    }

    // Build leads_to edges: patterns from the same session where one has a higher runIndex
    const bySession = new Map<string, GlobalSuccessPattern[]>();
    for (const p of patterns) {
      const sid = p.sourceSessionId || p.sessionId;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid)!.push(p);
    }

    for (const sessionPatterns of bySession.values()) {
      if (sessionPatterns.length < 2) continue;
      sessionPatterns.sort((a, b) => a.runIndex - b.runIndex);
      for (let i = 0; i < sessionPatterns.length - 1; i++) {
        const edge: KnowledgeEdge = {
          id: `edge-${randomUUID()}`,
          fromPatternId: sessionPatterns[i].id,
          toPatternId: sessionPatterns[i + 1].id,
          relationship: "leads_to",
          strength: 0.7,
          observedCount: 1,
          createdAt: Date.now(),
        };
        await this.addEdge(edge);
        newEdges++;
      }
    }

    log(`Rebuilt ${newEdges} knowledge graph edges from ${patterns.length} patterns`);
    return newEdges;
  }

  async pruneEdges(validNodeIds: Set<string>): Promise<number> {
    const edges = await this.getEdges();
    let removed = 0;
    for (const edge of edges) {
      if (!validNodeIds.has(edge.fromPatternId) || !validNodeIds.has(edge.toPatternId)) {
        await this.deleteEdge(edge.id);
        removed++;
      }
    }
    if (removed > 0) {
      log(`Pruned ${removed} orphaned knowledge graph edges`);
    }
    return removed;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function edgeToRow(edge: KnowledgeEdge): Record<string, unknown> {
  return {
    id: edge.id,
    from_pattern_id: edge.fromPatternId,
    to_pattern_id: edge.toPatternId,
    relationship: edge.relationship,
    strength: edge.strength,
    observed_count: edge.observedCount,
    created_at: edge.createdAt,
    vector: [0],
  };
}

function rowToEdge(row: Record<string, unknown>): KnowledgeEdge {
  return {
    id: String(row.id ?? ""),
    fromPatternId: String(row.from_pattern_id ?? ""),
    toPatternId: String(row.to_pattern_id ?? ""),
    relationship: (row.relationship as KnowledgeRelationship) ?? "similar_to",
    strength: Number(row.strength ?? 0),
    observedCount: Number(row.observed_count ?? 0),
    createdAt: Number(row.created_at ?? 0),
  };
}
