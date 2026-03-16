/**
 * Compute health metrics for global memory.
 * Reused by CLI, web endpoint, and dashboard.
 */

import type { GlobalMemoryManager } from "./store.js";
import type { MemoryHealth } from "./types.js";

export async function computeHealth(globalManager: GlobalMemoryManager): Promise<MemoryHealth> {
  const patternStore = globalManager.getPatternStore();
  const knowledgeGraph = globalManager.getKnowledgeGraph();

  const patternCount = (await patternStore?.count()) ?? 0;
  const lessonCount = await globalManager.getLessonCount();
  const edgeCount = (await knowledgeGraph?.countEdges()) ?? 0;

  let avgAge = 0;
  let avgQuality = 0;
  let staleCount = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  if (patternCount > 0 && patternStore) {
    const patterns = await patternStore.getAll();
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
    knowledgeGraphEdges: edgeCount,
    oldestPattern: oldest,
    newestPattern: newest,
  };
}
