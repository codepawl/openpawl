/**
 * Markdown renderer for diff output — valid CommonMark tables.
 */

import type { DiffChain, RunDiff, TaskDiff, Trend } from "../types.js";

/** Render a full DiffChain as markdown. */
export function renderDiffMarkdown(chain: DiffChain): string {
  const sections: string[] = [];

  sections.push(`# Goal Diff — ${chain.sessionId} (${chain.totalRuns} runs)`);

  for (const diff of chain.runDiffs) {
    sections.push(renderRunDiffMarkdown(diff));
  }

  if (chain.runDiffs.length > 1) {
    sections.push(renderOverallTrendMarkdown(chain));
  }

  return sections.join("\n\n---\n\n") + "\n";
}

/** Render a single RunDiff as markdown. */
export function renderRunDiffMarkdown(diff: RunDiff): string {
  const sections: string[] = [];

  sections.push(`## Run ${diff.fromRun} → Run ${diff.toRun}`);

  // Task changes table
  const changedTasks = diff.taskDiffs.filter((t) => t.status !== "unchanged");
  if (changedTasks.length > 0) {
    sections.push("### Task Changes");
    sections.push("");
    sections.push("| Status | Task | Description | Confidence Delta |");
    sections.push("|--------|------|-------------|-----------------|");
    for (const task of changedTasks) {
      sections.push(formatTaskRow(task));
    }
  }

  // Metrics table
  const m = diff.metricDiffs;
  sections.push("");
  sections.push("### Metrics");
  sections.push("");
  sections.push("| Metric | Delta |");
  sections.push("|--------|-------|");
  sections.push(`| Confidence | ${formatDelta(m.averageConfidenceDelta)} |`);
  sections.push(`| Tokens | ${(m.totalTokenDelta ?? 0) >= 0 ? "+" : ""}${(m.totalTokenDelta ?? 0).toLocaleString()} |`);
  sections.push(`| Duration | ${formatDurationDelta(m.totalDurationDelta)} |`);
  sections.push(`| Reworks | ${m.reworkCountDelta >= 0 ? "+" : ""}${m.reworkCountDelta} |`);
  sections.push(`| Auto-approved | ${m.autoApprovedDelta >= 0 ? "+" : ""}${m.autoApprovedDelta} |`);
  sections.push(`| Tasks added | ${m.tasksAddedCount} |`);
  sections.push(`| Tasks removed | ${m.tasksRemovedCount} |`);

  // Memory impact
  const mem = diff.memoryDiff;
  if (mem.patternsRetrievedDelta !== 0 || mem.newPatternsStoredDelta !== 0) {
    sections.push("");
    sections.push("### Memory Impact");
    sections.push("");
    sections.push(`- Patterns retrieved: ${formatIntDelta(mem.patternsRetrievedDelta)}`);
    sections.push(`- New patterns stored: ${formatIntDelta(mem.newPatternsStoredDelta)}`);
    sections.push(`- Global promotions: ${formatIntDelta(mem.globalPromotionsDelta)}`);
    if (mem.lessonsApplied.length > 0) {
      sections.push(`- Lessons applied: ${mem.lessonsApplied.length}`);
    }
  }

  // Routing changes
  if (diff.routingDiffs.length > 0) {
    sections.push("");
    sections.push("### Routing Changes");
    sections.push("");
    sections.push("| Task | From | To | Reason |");
    sections.push("|------|------|----|--------|");
    for (const r of diff.routingDiffs) {
      sections.push(`| ${r.taskId} | ${r.fromAgent} | ${r.toAgent} | ${r.reason} |`);
    }
  }

  // Team changes
  const t = diff.teamDiff;
  if (t.agentsAdded.length > 0 || t.agentsRemoved.length > 0) {
    sections.push("");
    sections.push("### Team Changes");
    sections.push("");
    for (const a of t.agentsAdded) sections.push(`- **Added:** ${a}`);
    for (const a of t.agentsRemoved) sections.push(`- **Removed:** ${a}`);
  }

  return sections.join("\n");
}

/** Render the overall trend section. */
export function renderOverallTrendMarkdown(chain: DiffChain): string {
  const trend = chain.overallTrend;
  const sections: string[] = [];

  sections.push(`## Overall Trend (${chain.totalRuns} runs)`);
  sections.push("");
  sections.push(`- Confidence: ${trendLabel(trend.confidenceTrend)} ${trendArrow(trend.confidenceTrend)}`);
  sections.push(`- Learning efficiency: ${trend.learningEfficiency.toFixed(3)} per run`);

  if (trend.plateauDetected && trend.plateauMessage) {
    sections.push("");
    sections.push(`> **Plateau Warning:** ${trend.plateauMessage}`);
  }

  return sections.join("\n");
}

/** Render a "Learning Progression" section for appending to audit trails. */
export function renderLearningProgression(chain: DiffChain): string {
  const sections: string[] = [];

  sections.push("## Learning Progression");
  sections.push("");

  for (const diff of chain.runDiffs) {
    const m = diff.metricDiffs;
    sections.push(`### Run ${diff.fromRun} → Run ${diff.toRun}`);
    sections.push("");
    sections.push(`- Confidence delta: ${formatDelta(m.averageConfidenceDelta)}`);
    sections.push(`- Token delta: ${(m.totalTokenDelta ?? 0) >= 0 ? "+" : ""}${(m.totalTokenDelta ?? 0).toLocaleString()}`);
    sections.push(`- Tasks added: ${m.tasksAddedCount}, removed: ${m.tasksRemovedCount}`);
    sections.push(`- Rework delta: ${m.reworkCountDelta >= 0 ? "+" : ""}${m.reworkCountDelta}`);
    sections.push("");
  }

  const trend = chain.overallTrend;
  sections.push(`**Overall:** Confidence ${trendLabel(trend.confidenceTrend)}`);

  if (trend.plateauDetected && trend.plateauMessage) {
    sections.push("");
    sections.push(`> ${trend.plateauMessage}`);
  }

  return sections.join("\n");
}

function formatTaskRow(task: TaskDiff): string {
  const symbol = task.status === "added" ? "+" : task.status === "removed" ? "-" : "~";
  const desc = task.description.slice(0, 50);
  const delta = task.confidenceDelta != null ? formatDelta(task.confidenceDelta) : "—";
  return `| ${symbol} ${task.status} | ${task.taskId} | ${desc} | ${delta} |`;
}

function formatDelta(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}`;
}

function formatDurationDelta(ms: number): string {
  const sign = ms >= 0 ? "+" : "-";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${abs}ms`;
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min > 0) return `${sign}${min}m${s.toString().padStart(2, "0")}s`;
  return `${sign}${sec}s`;
}

function formatIntDelta(v: number): string {
  return `${v >= 0 ? "+" : ""}${v}`;
}

function trendLabel(trend: Trend): string {
  switch (trend) {
    case "improving": return "improving";
    case "degrading": return "degrading";
    case "stable": return "stable";
  }
}

function trendArrow(trend: Trend): string {
  switch (trend) {
    case "improving": return "↑↑";
    case "degrading": return "↓↓";
    case "stable": return "→→";
  }
}
