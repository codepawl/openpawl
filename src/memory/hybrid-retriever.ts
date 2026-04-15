/**
 * Hybrid Retriever — LanceDB candidates → Hebbian re-ranking → final results.
 *
 * LanceDB does the heavy lifting (embedding, ANN search).
 * The Hebbian layer only re-ranks a small candidate set, adding decay,
 * co-activation, and spreading activation signals.
 */

import type { HebbianMemory, MemoryResult, MemoryNode } from "./hebbian/index.js";
import { profileStart } from "../telemetry/profiler.js";
import { debugLog, isDebugEnabled } from "../debug/logger.js";

/**
 * A candidate from the upstream LanceDB search.
 * The `id` is shared with the Hebbian graph node.
 */
export interface LanceCandidate {
  id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

export interface HybridRetrieverOptions {
  candidateCount: number;
  finalCount: number;
  enabled: boolean;
}

const DEFAULTS: HybridRetrieverOptions = {
  candidateCount: 20,
  finalCount: 5,
  enabled: true,
};

export class HybridRetriever {
  private hebbian: HebbianMemory;
  private options: HybridRetrieverOptions;

  constructor(
    hebbian: HebbianMemory,
    options?: Partial<HybridRetrieverOptions>,
  ) {
    this.hebbian = hebbian;
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Re-rank LanceDB candidates using the Hebbian graph.
   * If Hebbian is disabled, returns candidates in their original order.
   *
   * @param candidates - Results from LanceDB vector search
   * @param topK - Override for finalCount
   */
  rerank(candidates: LanceCandidate[], topK?: number): MemoryResult[] {
    const finish = profileStart("memory_retrieval", `rerank_${candidates.length}`, { candidateCount: candidates.length });
    const limit = topK ?? this.options.finalCount;

    if (!this.options.enabled || candidates.length === 0) {
      finish();
      return candidates.slice(0, limit).map(candidateToResult);
    }

    // Ensure all candidates have nodes in the Hebbian graph
    for (const c of candidates) {
      const existing = this.hebbian.getNode(c.id);
      if (!existing) {
        this.hebbian.storeNode(c.content, {
          id: c.id,
          category: "context",
          metadata: c.metadata ?? {},
        });
      }
    }

    // Build seeds and similarity map
    const seeds = candidates.map((c) => ({
      nodeId: c.id,
      activation: c.similarity,
    }));

    const similarityMap = new Map<string, number>();
    for (const c of candidates) {
      similarityMap.set(c.id, c.similarity);
    }

    // Recall triggers spreading activation + Hebbian update + scoring
    const results = this.hebbian.recall(seeds, similarityMap, limit);
    finish();

    // Debug: log retrieval results
    if (isDebugEnabled()) {
      debugLog("info", "memory", "memory:retrieval", {
        data: {
          candidateCount: candidates.length,
          resultCount: results.length,
          topScores: results.slice(0, 5).map((r) => ({
            id: r.node.id,
            score: Math.round(r.score * 1000) / 1000,
          })),
        },
      });
    }

    return results;
  }

  /**
   * Store a memory in the Hebbian graph.
   * The caller is responsible for also storing in LanceDB.
   */
  store(
    content: string,
    options?: {
      id?: string;
      importance?: number;
      category?: MemoryNode["category"];
      metadata?: Record<string, unknown>;
      coActivateWith?: string[];
    },
  ): string {
    const id = this.hebbian.storeNode(content, {
      id: options?.id,
      importance: options?.importance,
      category: options?.category,
      metadata: options?.metadata,
    });

    if (options?.coActivateWith && options.coActivateWith.length > 0) {
      this.hebbian.coActivate([id, ...options.coActivateWith]);
    }

    return id;
  }

  /**
   * Co-activate memories that were used together in agent reasoning.
   */
  coActivate(ids: string[]): void {
    this.hebbian.coActivate(ids);
  }

  /**
   * Advance decay by N ticks (call at session end).
   */
  step(ticks: number): void {
    this.hebbian.step(ticks);
  }

  /**
   * Get stats for /memory stats command.
   */
  getStats(): {
    nodeCount: number;
    edgeCount: number;
    avgStrength: number;
    categoryBreakdown: Record<string, number>;
  } {
    return this.hebbian.getStats();
  }

  getHebbian(): HebbianMemory {
    return this.hebbian;
  }

  close(): void {
    this.hebbian.close();
  }
}

function candidateToResult(c: LanceCandidate): MemoryResult {
  return {
    node: {
      id: c.id,
      content: c.content,
      strength: 1.0,
      activation: c.similarity,
      importance: 0.5,
      category: "context",
      metadata: c.metadata ?? {},
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    },
    score: c.similarity,
    breakdown: {
      activation: c.similarity,
      similarity: c.similarity,
      strength: 1.0,
      importance: 0.5,
    },
  };
}
