/**
 * CLI drift command — standalone goal drift check without starting a sprint.
 */

import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";
import { logger } from "../core/logger.js";
import { detectDrift } from "../drift/detector.js";
import type { DriftResult } from "../drift/types.js";
import { DecisionStore } from "../journal/store.js";
import { GlobalMemoryManager } from "../memory/global/store.js";

async function loadDecisions(): Promise<import("../journal/types.js").Decision[]> {
  try {
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");
    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (!embedder) return [];

    const globalMgr = new GlobalMemoryManager();
    await globalMgr.init(embedder);
    const db = globalMgr.getDb();
    if (!db) return [];

    const store = new DecisionStore();
    await store.init(db);
    return store.getAll();
  } catch {
    return [];
  }
}

function renderDriftResult(result: DriftResult, verbose: boolean): void {
  if (!result.hasDrift) {
    logger.plain(pc.green(`${ICONS.success} No conflicts with past decisions.`));
    return;
  }

  const icon = result.severity === "hard" ? "🚨" : ICONS.warning;
  const label = result.severity === "hard" ? "Strong drift detected" : "Drift detected";

  logger.plain(
    `${icon} ${pc.yellow(`${label} — ${result.conflicts.length} conflict(s) with past decisions`)}`,
  );

  for (const conflict of result.conflicts) {
    const d = conflict.decision;
    const date = new Date(d.capturedAt).toISOString().slice(0, 10);
    const permanent = (d as import("../journal/types.js").Decision & { permanent?: boolean }).permanent;
    const lockIcon = permanent ? " 🔒" : "";
    const typeBadge = conflict.conflictType === "direct"
      ? pc.red("[direct]")
      : conflict.conflictType === "indirect"
        ? pc.yellow("[indirect]")
        : pc.dim("[ambiguous]");

    logger.plain("");
    logger.plain(pc.dim("┌─────────────────────────────────────────────────────────────┐"));
    logger.plain(`│ ${typeBadge} Conflict${lockIcon}`);
    logger.plain(pc.dim("├─────────────────────────────────────────────────────────────┤"));
    logger.plain(`│ ${conflict.explanation}`);
    logger.plain(`│`);
    logger.plain(`│ Past decision (${date}, ${d.recommendedBy}, confidence ${d.confidence.toFixed(2)}):`);
    logger.plain(`│ "${d.decision}"`);
    logger.plain(`│ Reasoning: "${d.reasoning.slice(0, 100)}${d.reasoning.length > 100 ? "..." : ""}"`);
    logger.plain(pc.dim("└─────────────────────────────────────────────────────────────┘"));
  }

  if (verbose) {
    logger.plain("");
    logger.plain(pc.dim(`Checked ${result.conflicts.length} conflict(s) at ${new Date(result.checkedAt).toISOString()}`));
  }
}

export async function runDriftCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    logger.plain([
      pc.bold("openpawl drift") + " — Check goal for decision conflicts",
      "",
      "Usage:",
      '  openpawl drift "Add Redis caching"        Check goal against decisions',
      '  openpawl drift "Add Redis caching" --verbose  Show all checked decisions',
    ].join("\n"));
    return;
  }

  const verbose = args.includes("--verbose");
  const goal = args.filter((a) => a !== "--verbose").join(" ").trim();

  if (!goal) {
    logger.error("Please provide a goal to check.");
    return;
  }

  const decisions = await loadDecisions();
  if (decisions.length === 0) {
    logger.plain(pc.green("✓ No past decisions found — nothing to check against."));
    return;
  }

  const result = detectDrift(goal, decisions);
  renderDriftResult(result, verbose);
}
