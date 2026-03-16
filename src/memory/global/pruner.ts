/**
 * GlobalPruner — removes stale/low-quality patterns and lessons from global memory.
 * Never prunes patterns where promotedBy === "user".
 */

import type { GlobalMemoryManager } from "./store.js";
import type { GlobalSuccessPattern } from "./types.js";
import { logger, isDebugMode } from "../../core/logger.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

export interface PruneOptions {
  maxAgeDays?: number;
  minQuality?: number;
  staleDays?: number;
}

export interface PruneResult {
  patternsRemoved: number;
  lessonsRemoved: number;
  edgesRemoved: number;
}

const DEFAULT_MAX_AGE_DAYS = 180;
const DEFAULT_MIN_QUALITY = 0.3;
const DEFAULT_STALE_DAYS = 60;

export class GlobalPruner {
  private readonly globalManager: GlobalMemoryManager;

  constructor(globalManager: GlobalMemoryManager) {
    this.globalManager = globalManager;
  }

  async prune(opts?: PruneOptions): Promise<PruneResult> {
    const maxAgeDays = opts?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const minQuality = opts?.minQuality ?? DEFAULT_MIN_QUALITY;
    const staleDays = opts?.staleDays ?? DEFAULT_STALE_DAYS;

    const result: PruneResult = { patternsRemoved: 0, lessonsRemoved: 0, edgesRemoved: 0 };

    const patternStore = this.globalManager.getPatternStore();
    if (!patternStore) return result;

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const staleMs = staleDays * 24 * 60 * 60 * 1000;

    // Prune old patterns
    const patterns = await patternStore.getAll();
    const validPatternIds = new Set<string>();

    for (const p of patterns) {
      const gp = p as GlobalSuccessPattern;
      const age = now - p.createdAt;

      // Never prune user-promoted patterns
      if (gp.promotedBy === "user") {
        validPatternIds.add(p.id);
        continue;
      }

      // Remove old low-quality patterns
      const isOldAndLowQuality = age > maxAgeMs && p.confidence < minQuality;
      // Remove stale patterns (not retrieved in staleDays AND low quality)
      const isStale = age > staleMs && p.confidence < 0.5;

      if (isOldAndLowQuality || isStale) {
        await patternStore.delete(p.id);
        result.patternsRemoved++;
      } else {
        validPatternIds.add(p.id);
      }
    }

    // Prune old lessons
    const lessons = await this.globalManager.getAllLessons();
    for (const lesson of lessons) {
      const age = now - lesson.createdAt;

      // Never prune user-promoted lessons
      if (lesson.promotedBy === "user") continue;

      const isOldAndUnused = age > maxAgeMs && lesson.retrievalCount === 0;
      const isStale = age > staleMs && !lesson.helpedAvoidFailure;

      if (isOldAndUnused || isStale) {
        await this.globalManager.deleteLesson(lesson.id);
        result.lessonsRemoved++;
      }
    }

    // Clean orphaned knowledge graph edges
    const knowledgeGraph = this.globalManager.getKnowledgeGraph();
    if (knowledgeGraph) {
      result.edgesRemoved = await knowledgeGraph.pruneEdges(validPatternIds);
    }

    if (result.patternsRemoved > 0 || result.lessonsRemoved > 0 || result.edgesRemoved > 0) {
      log(`Pruned: ${result.patternsRemoved} patterns, ${result.lessonsRemoved} lessons, ${result.edgesRemoved} edges`);
    }

    return result;
  }
}
