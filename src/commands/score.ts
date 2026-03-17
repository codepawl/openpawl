/**
 * CLI score command — display vibe coding score and trends.
 */

import pc from "picocolors";
import { logger } from "../core/logger.js";
import type { VibeScoreEntry, DimensionName, BehaviorPattern } from "../score/types.js";

const SEPARATOR = "━".repeat(49);
const DIM_LABELS: Record<DimensionName, string> = {
  team_trust: "Team Trust",
  review_engagement: "Review Engagement",
  warning_response: "Warning Response",
  confidence_alignment: "Confidence Alignment",
};

function scoreColor(score: number): (s: string) => string {
  if (score > 70) return pc.green;
  if (score > 40) return pc.yellow;
  return pc.red;
}

function renderBar(score: number, max: number): string {
  const filled = Math.round((score / max) * 20);
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function parseDays(since: string): number {
  const match = since.match(/^(\d+)([dw])$/);
  if (!match) return 7;
  const [, n, unit] = match;
  return unit === "w" ? Number(n) * 7 : Number(n);
}

async function loadStore(): Promise<{ store: InstanceType<typeof import("../score/store.js").VibeScoreStore> } | null> {
  try {
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const { VibeScoreStore } = await import("../score/store.js");

    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (!embedder) return null;

    const globalMgr = new GlobalMemoryManager();
    await globalMgr.init(embedder);
    const db = globalMgr.getDb();
    if (!db) return null;

    const store = new VibeScoreStore();
    await store.init(db);
    return { store };
  } catch {
    return null;
  }
}

function renderScoreOverview(entry: VibeScoreEntry, patterns: BehaviorPattern[]): void {
  const colorFn = scoreColor(entry.overall);

  logger.plain(pc.dim(SEPARATOR));
  logger.plain(colorFn(pc.bold(`  Vibe Score: ${entry.overall}/100`)));
  logger.plain(pc.dim(`  ${entry.date}`));
  logger.plain(pc.dim(SEPARATOR));

  // Dimension bars
  const dims: [DimensionName, number][] = [
    ["team_trust", entry.teamTrust],
    ["review_engagement", entry.reviewEngagement],
    ["warning_response", entry.warningResponse],
    ["confidence_alignment", entry.confidenceAlignment],
  ];

  for (const [name, score] of dims) {
    const label = DIM_LABELS[name].padEnd(22);
    const bar = renderBar(score, 25);
    const scoreStr = `${score.toFixed(1)}/25`;
    logger.plain(`  ${label} ${bar} ${scoreStr}`);
  }

  // Patterns
  if (patterns.length > 0) {
    logger.plain("");
    for (const p of patterns) {
      const icon = p.sentiment === "positive" ? pc.green("↑") : p.sentiment === "negative" ? pc.red("↓") : pc.dim("→");
      logger.plain(`  ${icon} ${p.label}`);
    }
  }

  // Tip
  if (entry.tip) {
    logger.plain("");
    logger.plain(pc.cyan(`  Tip: ${entry.tip}`));
  }

  logger.plain(pc.dim(SEPARATOR));
}

function renderHistory(scores: VibeScoreEntry[]): void {
  if (scores.length === 0) {
    logger.plain(pc.dim("  No score history available."));
    return;
  }

  logger.plain(pc.dim(SEPARATOR));
  logger.plain(pc.bold("  Score History"));
  logger.plain(pc.dim(SEPARATOR));
  logger.plain(`  ${"Date".padEnd(12)} ${"Score".padEnd(8)} ${"Trust".padEnd(8)} ${"Review".padEnd(8)} ${"Warning".padEnd(8)} ${"Conf".padEnd(8)}`);
  logger.plain(pc.dim(`  ${"─".repeat(12)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)}`));

  for (const s of scores) {
    const colorFn = scoreColor(s.overall);
    logger.plain(
      `  ${s.date.padEnd(12)} ${colorFn(String(s.overall).padEnd(8))} ${String(s.teamTrust.toFixed(1)).padEnd(8)} ${String(s.reviewEngagement.toFixed(1)).padEnd(8)} ${String(s.warningResponse.toFixed(1)).padEnd(8)} ${String(s.confidenceAlignment.toFixed(1)).padEnd(8)}`,
    );
  }

  logger.plain(pc.dim(SEPARATOR));
}

export async function runScoreCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    logger.plain([
      pc.bold("teamclaw score") + " — View your vibe coding score",
      "",
      "Usage:",
      "  teamclaw score                   Show current score",
      "  teamclaw score --history         Week-by-week history",
      "  teamclaw score --since 30d       Time window (default: 7d)",
      "  teamclaw score --events          Show scoring events",
      "  teamclaw score --dimension trust Show single dimension detail",
    ].join("\n"));
    return;
  }

  const result = await loadStore();
  if (!result) {
    logger.plain(pc.yellow("No score data available. Run a work session first."));
    return;
  }

  const { store } = result;

  const sinceIdx = args.indexOf("--since");
  const sinceValue = sinceIdx >= 0 ? args[sinceIdx + 1] ?? "7d" : "7d";
  const days = parseDays(sinceValue);

  const showHistory = args.includes("--history");
  const showEvents = args.includes("--events");

  if (showHistory) {
    const scores = await store.getRecent(days);
    renderHistory(scores);
    return;
  }

  const latest = await store.getLatest();
  if (!latest) {
    logger.plain(pc.yellow("No score data yet. Complete a work session to generate your first score."));
    return;
  }

  let patterns: BehaviorPattern[] = [];
  try {
    patterns = JSON.parse(latest.patternsJson);
  } catch {
    patterns = [];
  }

  renderScoreOverview(latest, patterns);

  if (showEvents) {
    try {
      const events = JSON.parse(latest.eventsJson);
      if (events.length > 0) {
        logger.plain("");
        logger.plain(pc.bold("  Scoring Events:"));
        for (const evt of events) {
          const icon = evt.type === "bonus" ? pc.green("+") : pc.red("-");
          logger.plain(`  ${icon}${evt.points} ${evt.label} (${evt.dimension})`);
        }
      }
    } catch {
      // Malformed events
    }
  }
}
