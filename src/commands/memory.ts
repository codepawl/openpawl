/**
 * CLI command: teamclaw memory <subcommand>
 */

import { readFile, writeFile } from "node:fs/promises";
import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import { loadTeamConfig } from "../core/team-config.js";
import { VectorMemory } from "../core/knowledge-base.js";
import { SuccessPatternStore } from "../memory/success/store.js";
import { PatternQualityStore } from "../memory/success/quality.js";
import { GlobalMemoryManager } from "../memory/global/store.js";
import { PromotionEngine } from "../memory/global/promoter.js";
import { GlobalPruner } from "../memory/global/pruner.js";
import { computeHealth } from "../memory/global/health.js";
import { exportGlobalMemory, importGlobalMemory } from "../memory/global/portability.js";
import type { MemoryExport } from "../memory/global/types.js";

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

async function getEmbedder() {
  const teamConfig = await loadTeamConfig();
  const vm = new VectorMemory(CONFIG.vectorStorePath, teamConfig?.memory_backend ?? CONFIG.memoryBackend);
  await vm.init();
  const embedder = vm.getEmbedder();
  const db = vm.getDb();
  if (!embedder) throw new Error("Embedder not available — is the gateway running?");
  return { vm, embedder, db };
}

async function getGlobalManager() {
  const { embedder } = await getEmbedder();
  const gm = new GlobalMemoryManager();
  await gm.init(embedder);
  return { gm, embedder };
}

export async function runMemoryCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    logger.plain("Usage: teamclaw memory <subcommand>");
    logger.plain("");
    logger.plain("Subcommands:");
    logger.plain("  health                  Show global memory health stats");
    logger.plain("  promote <id>            Promote a session pattern to global");
    logger.plain("  demote <id>             Remove a pattern from global memory");
    logger.plain("  export [--output file]  Export global memory to JSON");
    logger.plain("  import <file>           Import global memory from JSON");
    logger.plain("  rebuild                 Rebuild knowledge graph edges");
    logger.plain("  prune [--max-age N]     Manually prune stale patterns");
    return;
  }

  if (sub === "health") {
    const { gm } = await getGlobalManager();
    const health = await computeHealth(gm);

    const ageDays = health.averagePatternAge > 0
      ? `${Math.round(health.averagePatternAge / (24 * 60 * 60 * 1000))}d`
      : "N/A";
    const oldestStr = health.oldestPattern
      ? new Date(health.oldestPattern).toISOString().slice(0, 10)
      : "N/A";
    const newestStr = health.newestPattern
      ? new Date(health.newestPattern).toISOString().slice(0, 10)
      : "N/A";

    logger.plain("Global Memory Health");
    logger.plain("─────────────────────────────────");
    logger.plain(`  Patterns:       ${health.totalGlobalPatterns}`);
    logger.plain(`  Lessons:        ${health.totalGlobalLessons}`);
    logger.plain(`  Graph Edges:    ${health.knowledgeGraphEdges}`);
    logger.plain(`  Avg Quality:    ${(health.averageQualityScore * 100).toFixed(1)}%`);
    logger.plain(`  Avg Age:        ${ageDays}`);
    logger.plain(`  Stale (>30d):   ${health.stalePatternsCount}`);
    logger.plain(`  Oldest:         ${oldestStr}`);
    logger.plain(`  Newest:         ${newestStr}`);
    return;
  }

  if (sub === "promote") {
    const id = args[1];
    if (!id) {
      logger.error("Usage: teamclaw memory promote <pattern-id>");
      process.exit(1);
    }
    const { vm, embedder, db } = await getEmbedder();
    if (!db) {
      logger.error("LanceDB not available");
      process.exit(1);
    }
    const gm = new GlobalMemoryManager();
    await gm.init(embedder);
    const sessionStore = new SuccessPatternStore(db, embedder);
    await sessionStore.init();
    const qualityStore = new PatternQualityStore(db);
    await qualityStore.init();
    const promoter = new PromotionEngine(gm, sessionStore, qualityStore, embedder);
    const ok = await promoter.promoteById(id);
    if (ok) {
      logger.success(`Promoted pattern ${id} to global memory`);
    } else {
      logger.error(`Failed to promote pattern ${id}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "demote") {
    const id = args[1];
    if (!id) {
      logger.error("Usage: teamclaw memory demote <pattern-id>");
      process.exit(1);
    }
    const { gm } = await getGlobalManager();
    const store = gm.getPatternStore();
    if (!store) {
      logger.error("Global pattern store not available");
      process.exit(1);
    }
    const ok = await store.delete(id);
    if (ok) {
      logger.success(`Demoted pattern ${id} from global memory`);
    } else {
      logger.error(`Pattern ${id} not found in global memory`);
      process.exit(1);
    }
    return;
  }

  if (sub === "export") {
    const outputPath = getArgValue(args, "--output");
    const { gm } = await getGlobalManager();
    const data = await exportGlobalMemory(gm);
    const json = JSON.stringify(data, null, 2);

    if (outputPath) {
      await writeFile(outputPath, json);
      logger.success(`Exported to ${outputPath} (${data.globalSuccessPatterns.length} patterns, ${data.globalFailureLessons.length} lessons)`);
    } else {
      logger.plain(json);
    }
    return;
  }

  if (sub === "import") {
    const filePath = args[1];
    if (!filePath) {
      logger.error("Usage: teamclaw memory import <file.json>");
      process.exit(1);
    }
    const { gm, embedder } = await getGlobalManager();
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as MemoryExport;
    const result = await importGlobalMemory(gm, data, embedder);
    logger.success(`Imported: ${result.patternsImported} patterns, ${result.lessonsImported} lessons, ${result.edgesImported} edges (${result.skipped} skipped)`);
    return;
  }

  if (sub === "rebuild") {
    const { gm, embedder } = await getGlobalManager();
    const store = gm.getPatternStore();
    const graph = gm.getKnowledgeGraph();
    if (!store || !graph) {
      logger.error("Global memory not available");
      process.exit(1);
    }
    const patterns = await store.getAll();
    const count = await graph.rebuildEdges(patterns as never, embedder);
    logger.success(`Rebuilt ${count} knowledge graph edges from ${patterns.length} patterns`);
    return;
  }

  if (sub === "prune") {
    const maxAge = Number(getArgValue(args, "--max-age")) || undefined;
    const minQuality = Number(getArgValue(args, "--min-quality")) || undefined;
    const { gm } = await getGlobalManager();
    const pruner = new GlobalPruner(gm);
    const result = await pruner.prune({ maxAgeDays: maxAge, minQuality });
    const total = result.patternsRemoved + result.lessonsRemoved + result.edgesRemoved;
    if (total > 0) {
      logger.success(`Pruned: ${result.patternsRemoved} patterns, ${result.lessonsRemoved} lessons, ${result.edgesRemoved} edges`);
    } else {
      logger.plain("Nothing to prune.");
    }
    return;
  }

  logger.error(`Unknown subcommand: memory ${sub}`);
  logger.error("Run `teamclaw memory --help` for usage.");
  process.exit(1);
}
