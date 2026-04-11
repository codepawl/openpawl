/**
 * Research report generator — produces a summary of the optimization run.
 */

import type { ResearchResult } from "./types.js";
import { ICONS } from "../tui/constants/icons.js";

export function generateReport(result: ResearchResult): string {
  const durationMin = Math.round(result.durationMs / 60_000);
  const improvement = result.finalScore - result.baseline;
  const improvementPct = result.baseline !== 0
    ? Math.round((improvement / Math.abs(result.baseline)) * 100)
    : 0;

  const lines: string[] = [
    `# Research Report: ${result.config.name}`,
    "",
    `## Summary`,
    `- Baseline: ${result.baseline}`,
    `- Final: ${result.finalScore} (${improvement > 0 ? "+" : ""}${improvement}, ${improvementPct}%)`,
    `- Iterations: ${result.totalIterations} (${result.keptChanges} kept, ${result.revertedChanges} reverted)`,
    `- Duration: ${durationMin} minutes`,
    "",
    `## Iteration Log`,
  ];

  for (const it of result.iterations) {
    const status = it.kept ? ICONS.success : ICONS.error;
    const delta = it.delta > 0 ? `+${it.delta}` : String(it.delta);
    lines.push(`${status} #${it.index}: ${it.description} (${it.scoreBefore}${ICONS.arrow}${it.scoreAfter}, ${delta})`);
    if (it.reason) lines.push(`  Reason: ${it.reason}`);
  }

  lines.push("");
  lines.push(`## Kept Changes`);
  const kept = result.iterations.filter((it) => it.kept);
  if (kept.length === 0) {
    lines.push("No changes were kept.");
  } else {
    for (const it of kept) {
      lines.push(`- ${it.description} (+${it.delta})`);
    }
  }

  return lines.join("\n");
}
