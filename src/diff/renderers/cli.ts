/**
 * CLI renderer for diff output — colored terminal output with plain text fallback.
 */

import pc from "picocolors";
import type { DiffChain, RunDiff, TaskDiff, Trend } from "../types.js";

export interface CliDiffOptions {
  verbose?: boolean;
  noColor?: boolean;
}

/** Render a full DiffChain to terminal string. */
export function renderDiffCli(chain: DiffChain, options: CliDiffOptions = {}): string {
  const lines: string[] = [];

  lines.push(title(`Goal Diff — ${chain.sessionId} (${chain.totalRuns} runs)`));
  lines.push(separator());

  for (const diff of chain.runDiffs) {
    lines.push(renderRunDiff(diff, options));
  }

  if (chain.runDiffs.length > 1) {
    lines.push(renderOverallTrend(chain));
  }

  return lines.join("\n");
}

/** Render a single RunDiff. */
export function renderRunDiff(diff: RunDiff, options: CliDiffOptions = {}): string {
  const lines: string[] = [];

  lines.push(subtitle(`Run ${diff.fromRun} → Run ${diff.toRun}`));
  lines.push(separator());

  // Tasks section
  lines.push(pc.bold("Tasks:"));
  for (const task of diff.taskDiffs) {
    if (task.status === "unchanged" && !options.verbose) continue;
    lines.push(formatTaskDiff(task));
  }

  lines.push("");

  // Metrics
  const m = diff.metricDiffs;
  lines.push(formatMetric("Confidence", m.averageConfidenceDelta, formatConfidence, false));
  lines.push(formatMetric("Tokens", m.totalTokenDelta ?? 0, (v) => `${v > 0 ? "+" : ""}${v.toLocaleString()}`, true));
  lines.push(formatMetric("Duration", m.totalDurationDelta, formatDuration, true));
  lines.push(formatMetric("Reworks", m.reworkCountDelta, (v) => String(v), true));
  lines.push(formatMetric("Auto-approved", m.autoApprovedDelta, (v) => `${v > 0 ? "+" : ""}${v}`, false));

  // Memory impact
  const mem = diff.memoryDiff;
  if (mem.patternsRetrievedDelta !== 0 || mem.newPatternsStoredDelta !== 0 || mem.globalPromotionsDelta !== 0) {
    lines.push(pc.bold("Memory impact:"));
    lines.push(`  Patterns retrieved: ${formatDelta(mem.patternsRetrievedDelta, false)}`);
    lines.push(`  New patterns stored: ${formatDelta(mem.newPatternsStoredDelta, true)}`);
    if (mem.globalPromotionsDelta !== 0) {
      lines.push(`  Global promotions: ${formatDelta(mem.globalPromotionsDelta, false)}`);
    }
    if (mem.lessonsApplied.length > 0) {
      lines.push(`  Lessons applied: ${mem.lessonsApplied.length}`);
    }
  }

  // Routing changes
  if (diff.routingDiffs.length > 0) {
    lines.push(pc.bold("Routing changes:"));
    for (const r of diff.routingDiffs) {
      lines.push(`  ${r.taskId}: ${r.fromAgent} → ${r.toAgent} (${r.reason})`);
    }
  }

  // Team changes
  const t = diff.teamDiff;
  if (t.agentsAdded.length > 0 || t.agentsRemoved.length > 0) {
    lines.push(pc.bold("Team changes:"));
    for (const a of t.agentsAdded) lines.push(`  ${pc.green("+")} ${a}`);
    for (const a of t.agentsRemoved) lines.push(`  ${pc.red("-")} ${a}`);
  }

  lines.push(separator());
  return lines.join("\n");
}

/** Render overall trend summary for multi-run chains. */
export function renderOverallTrend(chain: DiffChain): string {
  const lines: string[] = [];
  lines.push(subtitle(`Overall trend across ${chain.totalRuns} runs:`));

  const trend = chain.overallTrend;

  // Confidence values across runs
  const confValues = buildTrendValues(chain, "confidence");
  lines.push(`Confidence:    ${confValues} ${trendArrows(trend.confidenceTrend)}`);

  const tokenValues = buildTrendValues(chain, "tokens");
  lines.push(`Tokens:        ${tokenValues}`);

  lines.push(`Learning efficiency: ${trend.learningEfficiency.toFixed(3)} per run`);

  if (trend.plateauDetected && trend.plateauMessage) {
    lines.push("");
    lines.push(pc.yellow(trend.plateauMessage));
  }

  return lines.join("\n");
}

function buildTrendValues(chain: DiffChain, metric: "confidence" | "cost" | "tokens"): string {
  // We can reconstruct from the diffs: first value + cumulative deltas
  if (chain.runDiffs.length === 0) return "—";

  // Extract from metricDiffs
  if (metric === "confidence") {
    // We don't have the absolute value, just show deltas
    const arrows = chain.runDiffs.map((d) => {
      const delta = d.metricDiffs.averageConfidenceDelta;
      return delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
    });
    return arrows.join(" ");
  }

  const arrows = chain.runDiffs.map((d) => {
    const delta = d.metricDiffs.totalTokenDelta ?? 0;
    return delta < 0 ? "↓" : delta > 0 ? "↑" : "→";
  });
  return arrows.join(" ");
}

function formatTaskDiff(task: TaskDiff): string {
  const symbol = taskSymbol(task.status);
  const desc = task.description.slice(0, 40).padEnd(40);

  switch (task.status) {
    case "added":
      return pc.green(`  ${symbol} ${task.taskId}  ${desc} conf: — → ${(task.confidenceDelta ?? 0).toFixed(2)} (new task)`);
    case "removed":
      return pc.red(`  ${symbol} ${task.taskId}  ${desc} (removed)`);
    case "changed": {
      const confStr = task.confidenceDelta != null
        ? `conf: ${formatConfDelta(task.confidenceDelta)}`
        : "";
      return pc.yellow(`  ${symbol} ${task.taskId}  ${desc} ${confStr}`);
    }
    case "unchanged":
      return pc.dim(`  ${symbol} ${task.taskId}  ${desc}`);
    default:
      return `  ? ${task.taskId}  ${desc}`;
  }
}

function taskSymbol(status: string): string {
  switch (status) {
    case "added": return "+";
    case "removed": return "-";
    case "changed": return "~";
    case "unchanged": return "=";
    default: return "?";
  }
}

function formatConfDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "";
  const arrow = delta > 0 ? " ↑" : delta < 0 ? " ↓" : "";
  return `${sign}${delta.toFixed(2)}${arrow}`;
}

function formatMetric(
  label: string,
  delta: number,
  formatter: (v: number) => string,
  lowerIsBetter: boolean,
): string {
  const sign = delta >= 0 ? "+" : "";
  const formatted = formatter(Math.abs(delta));
  const arrow = delta === 0 ? "" : (delta > 0) !== lowerIsBetter ? " ↑" : " ↓";
  const color = delta === 0 ? pc.dim : (delta > 0) !== lowerIsBetter ? pc.green : pc.red;
  return `${label.padEnd(14)} ${color(`${sign}${formatted}${arrow}`)}`;
}

function formatDelta(delta: number, lowerIsBetter: boolean): string {
  const sign = delta >= 0 ? "+" : "";
  const arrow = delta === 0 ? "" : (delta > 0) !== lowerIsBetter ? " ↑" : " ↓";
  return `${sign}${delta}${arrow}`;
}

function formatConfidence(v: number): string {
  return v.toFixed(2);
}

function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${abs}ms`;
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min > 0) return `${min}m${s.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

function trendArrows(trend: Trend): string {
  switch (trend) {
    case "improving": return "↑↑";
    case "degrading": return "↓↓";
    case "stable": return "→→";
  }
}

function title(text: string): string {
  return pc.bold(pc.cyan(text));
}

function subtitle(text: string): string {
  return pc.bold(text);
}

function separator(): string {
  return "━".repeat(50);
}
