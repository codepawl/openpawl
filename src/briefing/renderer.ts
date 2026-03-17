/**
 * Briefing renderer — formats BriefingData for terminal output.
 * Uses picocolors for styling. Respects NO_COLOR env var.
 */

import pc from "picocolors";
import type { BriefingData, InterRunSummary } from "./types.js";

const SEPARATOR = "━".repeat(49);

function color(fn: (s: string) => string, text: string): string {
  return fn(text);
}

/**
 * Render the full session briefing for terminal display.
 * Returns an array of lines, max 12 content lines.
 */
export function renderBriefing(data: BriefingData): string {
  if (!data.lastSession) {
    return renderWelcome();
  }

  const lines: string[] = [];
  lines.push(color(pc.dim, SEPARATOR));
  lines.push(color(pc.cyan, "Previously on TeamClaw"));

  const daysLabel = data.lastSession.daysAgo === 0
    ? "today"
    : data.lastSession.daysAgo === 1
      ? "yesterday"
      : `${data.lastSession.daysAgo} days ago`;
  const shortId = data.lastSession.sessionId.slice(0, 16);
  lines.push(
    color(pc.dim, `Last session: ${daysLabel} (${shortId})`),
  );
  lines.push(color(pc.dim, SEPARATOR));

  // What was built — max 3 items
  if (data.whatWasBuilt.length > 0) {
    lines.push(color(pc.bold, "What was built:"));
    for (const item of data.whatWasBuilt.slice(0, 3)) {
      lines.push(color(pc.green, `→ ${item}`));
    }
  }

  // Team learnings — max 2 items
  if (data.teamLearnings.length > 0) {
    lines.push(color(pc.bold, "What the team learned:"));
    for (const lesson of data.teamLearnings.slice(0, 2)) {
      const short = lesson.length > 80 ? lesson.slice(0, 77) + "..." : lesson;
      lines.push(color(pc.blue, `→ ${short}`));
    }
  }

  // Left open — max 2 items
  if (data.leftOpen.length > 0) {
    lines.push(color(pc.bold, "Left open:"));
    for (const item of data.leftOpen.slice(0, 2)) {
      const short = item.taskDescription.length > 60
        ? item.taskDescription.slice(0, 57) + "..."
        : item.taskDescription;
      lines.push(color(pc.yellow, `→ "${short}" — ${item.reason}`));
    }
  }

  // Relevant past decisions — max 2
  if (data.relevantDecisions && data.relevantDecisions.length > 0) {
    lines.push(color(pc.bold, "Previously decided:"));
    for (const d of data.relevantDecisions.slice(0, 2)) {
      lines.push(color(pc.magenta, `→ ${d.decision} (${d.recommendedBy}, ${d.date}) — still applies?`));
    }
  }

  // Async think results (completed while away)
  if (data.asyncThinkResults && data.asyncThinkResults.length > 0) {
    lines.push(color(pc.bold, "Async think complete (while you were away):"));
    for (const r of data.asyncThinkResults.slice(0, 2)) {
      const q = r.question.length > 40 ? r.question.slice(0, 37) + "..." : r.question;
      const saved = r.savedToJournal ? pc.green("saved") : pc.dim("not saved");
      lines.push(color(pc.cyan, `  "${q}" — ${r.recommendation} (${(r.confidence * 100).toFixed(0)}%) [${saved}]`));
      lines.push(color(pc.dim, `  teamclaw think results ${r.jobId}`));
    }
  }

  // Team performance — only notable agents, max 2
  const notable = data.teamPerformance.filter((tp) => tp.trend !== "stable");
  if (notable.length > 0) {
    for (const entry of notable.slice(0, 2)) {
      if (entry.trend === "degrading" || entry.alert) {
        lines.push(color(pc.red, `→ ${entry.agentRole} below threshold — watch this`));
      } else if (entry.trend === "improving") {
        const delta = entry.confidenceDelta > 0
          ? `+${entry.confidenceDelta.toFixed(2)}`
          : entry.confidenceDelta.toFixed(2);
        lines.push(color(pc.green, `→ ${entry.agentRole} trending up (${delta} confidence)`));
      }
    }
  }

  lines.push(color(pc.dim, SEPARATOR));

  // Enforce max 12 content lines (excluding separators)
  const contentLines = lines.filter((l) => !l.includes(SEPARATOR));
  if (contentLines.length > 12) {
    // Rebuild with truncated content
    const truncated = contentLines.slice(0, 12);
    return [
      color(pc.dim, SEPARATOR),
      ...truncated,
      color(pc.dim, SEPARATOR),
    ].join("\n");
  }

  return lines.join("\n");
}

/** Render the first-time welcome message. */
export function renderWelcome(): string {
  return [
    color(pc.dim, SEPARATOR),
    color(pc.cyan, "Welcome to TeamClaw"),
    "Your AI team is ready. No previous sessions found.",
    color(pc.dim, SEPARATOR),
    "Your team remembers everything from here on.",
    color(pc.dim, SEPARATOR),
  ].join("\n");
}

/** Render compact inter-run summary (max 5 lines). */
export function renderInterRunSummary(summary: InterRunSummary): string {
  const confStr = summary.averageConfidence.toFixed(2);
  const targetStr = summary.targetConfidence.toFixed(2);
  return [
    color(pc.dim, "━".repeat(37)),
    color(pc.cyan, `Run ${summary.completedRun} complete → Starting Run ${summary.nextRun}`),
    `Confidence: ${confStr} → target ${targetStr}`,
    summary.newLessons > 0
      ? `Patterns retrieved: ${summary.newLessons} new lessons available`
      : "No new lessons from this run",
    color(pc.dim, "━".repeat(37)),
  ].join("\n");
}
