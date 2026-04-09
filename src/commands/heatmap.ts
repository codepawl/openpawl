/**
 * CLI commands for agent utilization heatmap.
 *
 * openpawl heatmap <sessionId>                  Current run heatmap
 * openpawl heatmap <sessionId> --run 2          Specific run
 * openpawl heatmap <sessionId> --all-runs       All runs side by side
 * openpawl heatmap <sessionId> --metric cost    Cost view
 * openpawl heatmap <sessionId> --view time      Time bucket view
 * openpawl heatmap --global                     Cross-session heatmap
 * openpawl heatmap --global --since 30d         Last 30 days
 * openpawl heatmap <sessionId> --suggestions    Optimization suggestions only
 */

import pc from "picocolors";
import { logger } from "../core/logger.js";
import { getSession } from "../replay/session-index.js";
import { readRecordingEvents } from "../replay/storage.js";
import { calculateUtilization } from "../heatmap/calculator.js";
import { buildHeatmap } from "../heatmap/builder.js";
import { generateSuggestions } from "../heatmap/suggestions.js";
import {
  getUtilizationSince,
  parseSinceDuration,
} from "../heatmap/global.js";
import type {
  AgentUtilization,
  HeatmapData,
  HeatmapMetric,
  HeatmapViewType,
  OptimizationSuggestion,
} from "../heatmap/types.js";
import type { ProfileData } from "../heatmap/suggestions.js";

export async function runHeatmapCommand(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const isGlobal = args.includes("--global");
  const suggestionsOnly = args.includes("--suggestions");
  const metricIdx = args.indexOf("--metric");
  const metric = metricIdx >= 0 ? (args[metricIdx + 1] as HeatmapMetric) ?? "duration" : "duration";
  const viewIdx = args.indexOf("--view");
  const viewType = viewIdx >= 0 ? (args[viewIdx + 1] as HeatmapViewType) ?? "task" : "task";
  const runIdx = args.indexOf("--run");
  const specificRun = runIdx >= 0 ? parseInt(args[runIdx + 1] ?? "1", 10) : 0;
  const allRuns = args.includes("--all-runs");
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] ?? "30d" : "30d";

  if (isGlobal) {
    await runGlobalHeatmap(since, metric);
    return;
  }

  const sessionId = args.find((a) => !a.startsWith("--") && args.indexOf(a) === 0) ?? args[0];
  if (!sessionId || sessionId.startsWith("--")) {
    logger.error("Usage: openpawl heatmap <sessionId>");
    process.exit(1);
  }

  const session = getSession(sessionId);
  if (!session) {
    logger.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }

  const events = await readRecordingEvents(sessionId);
  const maxRun = session.totalRuns || 1;

  if (allRuns) {
    // All runs side by side
    const allUtils: AgentUtilization[] = [];
    for (let i = 1; i <= maxRun; i++) {
      allUtils.push(...calculateUtilization(sessionId, i, events));
    }
    const heatmap = buildHeatmap(allUtils, "session", { metric, viewType: "run" });

    // Load profiles for suggestions
    const profiles = await loadProfiles();
    heatmap.suggestions = generateSuggestions(allUtils, profiles);

    renderHeatmapCli(heatmap, suggestionsOnly);
    return;
  }

  const run = specificRun > 0 ? specificRun : maxRun;
  const utilizations = calculateUtilization(sessionId, run, events);

  if (utilizations.length === 0) {
    logger.warn(`No utilization data for ${sessionId} run ${run}.`);
    return;
  }

  const heatmap = buildHeatmap(utilizations, "run", { metric, viewType });
  const profiles = await loadProfiles();
  heatmap.suggestions = generateSuggestions(utilizations, profiles);

  if (suggestionsOnly) {
    renderSuggestions(heatmap.suggestions);
    return;
  }

  renderHeatmapCli(heatmap, false);
}

async function runGlobalHeatmap(since: string, _metric: HeatmapMetric): Promise<void> {
  const sinceMs = parseSinceDuration(since);
  const entries = getUtilizationSince(sinceMs);

  if (entries.length === 0) {
    logger.warn("No global utilization data found. Run some sessions first.");
    return;
  }

  // Aggregate by agent role
  const agentMap = new Map<string, {
    role: string;
    totalUtil: number;
    totalConf: number;
    totalTasks: number;
    count: number;
    maxBottleneck: number;
  }>();

  for (const entry of entries) {
    const agg = agentMap.get(entry.agentRole) ?? {
      role: entry.agentRole,
      totalUtil: 0, totalConf: 0, totalTasks: 0, count: 0, maxBottleneck: 0,
    };
    agg.totalUtil += entry.utilizationPct;
    agg.totalConf += entry.averageConfidence;
    agg.totalTasks += entry.tasksHandled;
    agg.count++;
    agg.maxBottleneck = Math.max(agg.maxBottleneck, entry.bottleneckScore);
    agentMap.set(entry.agentRole, agg);
  }

  logger.plain(pc.bold(pc.cyan(`Global Agent Utilization (last ${since})`)));
  logger.plain("═".repeat(70));
  logger.plain(
    pc.bold("Agent".padEnd(20)) +
    pc.bold("Sessions".padEnd(10)) +
    pc.bold("Avg Util".padEnd(10)) +
    pc.bold("Avg Conf".padEnd(10)) +
    pc.bold("Tasks".padEnd(8)),
  );
  logger.plain("─".repeat(70));

  const sorted = Array.from(agentMap.values()).sort((a, b) => b.totalUtil / b.count - a.totalUtil / a.count);
  for (const agg of sorted) {
    const avgUtil = agg.totalUtil / agg.count;
    const avgConf = agg.totalConf / agg.count;
    const isBottleneck = avgUtil >= 0.8;

    const line =
      formatName(agg.role).padEnd(20) +
      String(agg.count).padEnd(10) +
      `${Math.round(avgUtil * 100)}%`.padEnd(10) +
      avgConf.toFixed(2).padEnd(10) +
      String(agg.totalTasks).padEnd(8);

    logger.plain(isBottleneck ? pc.red(line + " ← bottleneck") : line);
  }
}

function renderHeatmapCli(heatmap: HeatmapData, suggestionsOnly: boolean): void {
  if (suggestionsOnly) {
    renderSuggestions(heatmap.suggestions);
    return;
  }

  const scopeLabel = heatmap.scope === "run" ? `Run ${heatmap.runIndex}` :
    heatmap.scope === "session" ? "Session" : "Global";

  logger.plain(pc.bold(pc.cyan(`Agent Utilization — ${heatmap.sessionId} (${scopeLabel})`)));

  // Table header
  const colWidth = 14;
  const header =
    pc.bold("Agent".padEnd(20)) +
    pc.bold("Tasks".padEnd(7)) +
    pc.bold("Avg Duration".padEnd(colWidth)) +
    pc.bold("Avg Confidence".padEnd(colWidth + 2)) +
    pc.bold("Cost".padEnd(10)) +
    pc.bold("Utilization");

  logger.plain("─".repeat(80));
  logger.plain(header);
  logger.plain("─".repeat(80));

  for (let i = 0; i < heatmap.rows.length; i++) {
    const row = heatmap.rows[i];
    const util = row.overallUtilization;
    const utilPct = `${Math.round(util * 100)}%`;
    const bar = buildUtilBar(util, 14);

    // Find avg values from cells
    const durationStr = formatCellDuration(heatmap.cells[i]);
    const confStr = formatCellConfidence(heatmap.cells[i]);
    const costStr = formatCellCost(heatmap.cells[i]);

    const line =
      row.displayName.padEnd(20) +
      String(heatmap.cells[i]?.filter((c) => c.value > 0 && c.columnId !== "avg").length ?? 0).padEnd(7) +
      durationStr.padEnd(colWidth) +
      confStr.padEnd(colWidth + 2) +
      costStr.padEnd(10) +
      `${utilPct} ${bar}`;

    if (row.isBottleneck) {
      logger.plain(pc.red(line));
    } else if (util > 0.5) {
      logger.plain(pc.yellow(line));
    } else {
      logger.plain(line);
    }
  }

  // Bottleneck alerts
  if (heatmap.bottlenecks.length > 0) {
    logger.plain("");
    for (const alert of heatmap.bottlenecks) {
      logger.plain(pc.red(
        `Bottleneck detected: ${formatName(alert.agentRole)} ` +
        `(${Math.round(alert.utilizationPct * 100)}% utilization` +
        (alert.queueDepth > 1 ? `, ${alert.queueDepth} tasks queued)` : ")"),
      ));
    }
  }

  // Suggestions
  if (heatmap.suggestions.length > 0) {
    logger.plain("");
    renderSuggestions(heatmap.suggestions);
  }
}

function renderSuggestions(suggestions: OptimizationSuggestion[]): void {
  if (suggestions.length === 0) {
    logger.plain(pc.dim("No optimization suggestions."));
    return;
  }

  logger.plain(pc.bold("Suggestions:"));
  for (const s of suggestions) {
    const icon = s.type === "reassign" ? "→" :
      s.type === "parallelize" ? "‖" :
      s.type === "swap_model" ? "↕" : "×";
    logger.plain(`  ${pc.yellow(icon)} ${s.suggestion}`);
    logger.plain(`    ${pc.dim(`Impact: ${s.estimatedImpact}`)}`);
  }
}

function buildUtilBar(pct: number, width: number): string {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function formatName(nodeId: string): string {
  return nodeId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatCellDuration(cells: import("../heatmap/types.js").HeatmapCell[] | undefined): string {
  if (!cells) return "—";
  const activeCells = cells.filter((c) => c.columnId !== "avg" && c.displayValue !== "—");
  if (activeCells.length === 0) return "—";
  // Return the first non-empty display value as representative
  return activeCells[0].displayValue;
}

function formatCellConfidence(cells: import("../heatmap/types.js").HeatmapCell[] | undefined): string {
  if (!cells) return "—";
  const activeCells = cells.filter((c) => c.columnId !== "avg" && c.value > 0);
  if (activeCells.length === 0) return "—";
  const avg = activeCells.reduce((sum, c) => sum + c.value, 0) / activeCells.length;
  return avg.toFixed(2);
}

function formatCellCost(cells: import("../heatmap/types.js").HeatmapCell[] | undefined): string {
  if (!cells) return "—";
  const costCells = cells.filter((c) => c.columnId !== "avg" && c.displayValue.startsWith("$"));
  if (costCells.length === 0) return "—";
  return costCells[0].displayValue;
}

async function loadProfiles(): Promise<ProfileData[]> {
  try {
    const { ProfileStore } = await import("../agents/profiles/store.js");
    const store = new ProfileStore();
    // ProfileStore needs LanceDB init — try but don't fail
    const profiles = await store.getAll();
    return profiles.map((p) => ({
      agentRole: p.agentRole,
      taskTypeScores: p.taskTypeScores.map((ts) => ({
        taskType: ts.taskType,
        averageConfidence: ts.averageConfidence,
        successRate: ts.successRate,
        totalTasksCompleted: ts.totalTasksCompleted,
      })),
      overallScore: p.overallScore,
    }));
  } catch {
    return []; // No profiles available — suggestions will be limited
  }
}

function printHelp(): void {
  const lines = [
    "",
    pc.bold("openpawl heatmap") + " — Agent utilization heatmap",
    "",
    pc.bold("Usage:"),
    "  " + pc.green("openpawl heatmap <sessionId>") + "              Current run heatmap",
    "  " + pc.green("openpawl heatmap <sessionId> --run 2") + "     Specific run",
    "  " + pc.green("openpawl heatmap <sessionId> --all-runs") + "  All runs side by side",
    "  " + pc.green("openpawl heatmap --global") + "                Cross-session heatmap",
    "",
    pc.bold("Options:"),
    "  " + pc.green("--metric <m>") + "     Metric: duration, cost, confidence (default: duration)",
    "  " + pc.green("--view <v>") + "       View: task, time (default: task)",
    "  " + pc.green("--suggestions") + "    Show optimization suggestions only",
    "  " + pc.green("--since <dur>") + "    Global filter: 30d, 7d, 24h (default: 30d)",
    "",
    "Examples:",
    pc.dim("  openpawl heatmap sess_abc123"),
    pc.dim("  openpawl heatmap sess_abc123 --metric cost"),
    pc.dim("  openpawl heatmap sess_abc123 --suggestions"),
    pc.dim("  openpawl heatmap --global --since 7d"),
    "",
  ];
  console.log(lines.join("\n"));
}
