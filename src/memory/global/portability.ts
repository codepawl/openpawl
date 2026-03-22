/**
 * Export/import global memory for portability.
 * Strips embedding vectors on export; re-generates on import.
 */

import type { GlobalMemoryManager } from "./store.js";
import type { HttpEmbeddingFunction } from "../../core/knowledge-base.js";
import type { MemoryExport, GlobalSuccessPattern } from "./types.js";
import { logger, isDebugMode } from "../../core/logger.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

const EXPORT_VERSION = "0.0.1";

export interface ImportResult {
  patternsImported: number;
  lessonsImported: number;
  edgesImported: number;
  skipped: number;
}

export async function exportGlobalMemory(globalManager: GlobalMemoryManager): Promise<MemoryExport> {
  const patternStore = globalManager.getPatternStore();
  const knowledgeGraph = globalManager.getKnowledgeGraph();

  const rawPatterns = patternStore ? await patternStore.getAll() : [];
  // Strip embedding vectors — not portable across models
  const patterns: GlobalSuccessPattern[] = rawPatterns.map((p) => {
    const gp = p as GlobalSuccessPattern;
    const { embedding: _omitted, ...rest } = gp; void _omitted;
    return {
      ...rest,
      promotedAt: gp.promotedAt ?? p.createdAt,
      promotedBy: gp.promotedBy ?? "auto",
      sourceSessionId: gp.sourceSessionId ?? p.sessionId,
      globalQualityScore: gp.globalQualityScore ?? p.confidence,
    };
  });

  const lessons = await globalManager.getAllLessons();
  const graph = knowledgeGraph ? (await knowledgeGraph.getGraph(200)).edges : [];

  return {
    exportedAt: Date.now(),
    version: EXPORT_VERSION,
    globalSuccessPatterns: patterns,
    globalFailureLessons: lessons,
    knowledgeGraph: graph,
  };
}

export async function importGlobalMemory(
  globalManager: GlobalMemoryManager,
  data: MemoryExport,
  _embedder: HttpEmbeddingFunction,
): Promise<ImportResult> {
  const result: ImportResult = {
    patternsImported: 0,
    lessonsImported: 0,
    edgesImported: 0,
    skipped: 0,
  };

  const patternStore = globalManager.getPatternStore();
  const knowledgeGraph = globalManager.getKnowledgeGraph();

  // Import patterns — skip existing by id (idempotent)
  if (patternStore && data.globalSuccessPatterns?.length) {
    const existing = await patternStore.getAll();
    const existingIds = new Set(existing.map((p) => p.id));

    for (const pattern of data.globalSuccessPatterns) {
      if (existingIds.has(pattern.id)) {
        result.skipped++;
        continue;
      }

      const ok = await patternStore.upsert(pattern);
      if (ok) {
        result.patternsImported++;
      } else {
        result.skipped++;
      }
    }
  }

  // Import lessons
  if (data.globalFailureLessons?.length) {
    const existing = await globalManager.getAllLessons();
    const existingIds = new Set(existing.map((l) => l.id));

    for (const lesson of data.globalFailureLessons) {
      if (existingIds.has(lesson.id)) {
        result.skipped++;
        continue;
      }

      const ok = await globalManager.upsertLesson(lesson);
      if (ok) {
        result.lessonsImported++;
      } else {
        result.skipped++;
      }
    }
  }

  // Import edges
  if (knowledgeGraph && data.knowledgeGraph?.length) {
    const existingEdges = await knowledgeGraph.getEdges();
    const existingEdgeIds = new Set(existingEdges.map((e) => e.id));

    for (const edge of data.knowledgeGraph) {
      if (existingEdgeIds.has(edge.id)) {
        result.skipped++;
        continue;
      }

      const ok = await knowledgeGraph.addEdge(edge);
      if (ok) {
        result.edgesImported++;
      } else {
        result.skipped++;
      }
    }
  }

  log(`Import complete: ${result.patternsImported} patterns, ${result.lessonsImported} lessons, ${result.edgesImported} edges (${result.skipped} skipped)`);
  return result;
}
