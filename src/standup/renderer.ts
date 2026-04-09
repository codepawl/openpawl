/**
 * Standup renderer — formats StandupData for terminal and markdown output.
 * Uses picocolors for styling. Respects NO_COLOR env var.
 */

import pc from "picocolors";
import type { StandupData, WeeklySummary } from "./types.js";

const SEPARATOR = "━".repeat(49);

function color(fn: (s: string) => string, text: string): string {
  return fn(text);
}

export function renderStandup(data: StandupData): string {
  const lines: string[] = [];
  lines.push(color(pc.dim, SEPARATOR));
  lines.push(color(pc.cyan, `Standup — ${data.date}`));
  lines.push(color(pc.dim, SEPARATOR));

  // Yesterday section
  if (data.yesterday.sessions.length === 0) {
    lines.push(color(pc.dim, "No sessions yesterday — fresh start today"));
  } else {
    lines.push(color(pc.bold, "Yesterday:"));
    for (const s of data.yesterday.sessions) {
      const goalShort = s.goal.length > 45 ? s.goal.slice(0, 42) + "..." : s.goal;
      const rework = s.reworkCount > 0 ? color(pc.yellow, ` (${s.reworkCount} rework)`) : "";
      lines.push(color(pc.green, `  → ${goalShort} — ${s.tasksCompleted} tasks${rework}`));
    }
    if (data.yesterday.teamLearnings.length > 0) {
      for (const lesson of data.yesterday.teamLearnings.slice(0, 2)) {
        const short = lesson.length > 70 ? lesson.slice(0, 67) + "..." : lesson;
        lines.push(color(pc.blue, `  📝 ${short}`));
      }
    }
  }

  lines.push(color(pc.dim, SEPARATOR));

  // Blocked section
  if (data.blocked.length === 0) {
    lines.push(color(pc.dim, "Nothing blocked — clean slate"));
  } else {
    lines.push(color(pc.bold, "Blocked:"));
    for (const b of data.blocked) {
      const icon = b.priority === "high" ? "🔴" : b.priority === "medium" ? "🟡" : "🔵";
      const desc = b.description.length > 55 ? b.description.slice(0, 52) + "..." : b.description;
      lines.push(color(pc.yellow, `  ${icon} ${desc}`));
    }
  }

  lines.push(color(pc.dim, SEPARATOR));

  // Suggested section
  if (data.suggested.length === 0) {
    lines.push(color(pc.dim, "No suggested next steps — define your own goal"));
  } else {
    lines.push(color(pc.bold, "Suggested:"));
    for (const s of data.suggested) {
      const desc = s.description.length > 55 ? s.description.slice(0, 52) + "..." : s.description;
      lines.push(color(pc.blue, `  → ${desc}`));
    }
  }

  lines.push(color(pc.dim, SEPARATOR));

  // Footer
  const footer: string[] = [];
  if (data.streak > 0) footer.push(`🔥 ${data.streak}-day streak`);
  if (data.globalPatternsCount > 0) footer.push(`🧠 ${data.globalPatternsCount} global patterns`);
  lines.push(color(pc.dim, footer.join("  •  ")));

  lines.push(color(pc.dim, SEPARATOR));

  return lines.join("\n");
}

export function renderWeeklySummary(summary: WeeklySummary): string {
  const lines: string[] = [];
  lines.push(color(pc.dim, SEPARATOR));
  lines.push(color(pc.cyan, `Weekly Summary — ${summary.weekLabel}`));
  lines.push(color(pc.dim, SEPARATOR));

  lines.push(color(pc.bold, "Activity:"));
  lines.push(`  Sessions: ${summary.sessionCount}  •  Active days: ${summary.activeDays}/7`);
  lines.push(`  Tasks: ${summary.tasksCompleted} completed (${summary.autoApproved} auto-approved, ${summary.reworkCount} rework)`);

  const confStr = (summary.avgConfidence * 100).toFixed(0);
  let confDelta = "";
  if (summary.prevWeekAvgConfidence != null) {
    const delta = summary.avgConfidence - summary.prevWeekAvgConfidence;
    const sign = delta >= 0 ? "+" : "";
    confDelta = ` (${sign}${(delta * 100).toFixed(0)}% vs last week)`;
  }
  lines.push(`  Avg confidence: ${confStr}%${confDelta}`);

  if (summary.topDomains.length > 0) {
    lines.push(color(pc.bold, "Top domains:"));
    for (const d of summary.topDomains.slice(0, 3)) {
      lines.push(color(pc.green, `  → ${d.domain} (${d.taskCount} tasks)`));
    }
  }

  if (summary.bestDay) {
    lines.push(color(pc.bold, "Best day:"));
    lines.push(color(pc.green, `  → ${summary.bestDay.dayLabel}: ${summary.bestDay.taskCount} tasks, ${(summary.bestDay.avgConfidence * 100).toFixed(0)}% confidence`));
  }

  lines.push(color(pc.dim, SEPARATOR));

  const footer: string[] = [];
  if (summary.streak > 0) footer.push(`🔥 ${summary.streak}-day streak`);
  footer.push(`${summary.newGlobalPatterns} new global patterns`);
  footer.push(`${summary.newSessionPatterns} new session patterns`);
  if (footer.length > 0) lines.push(color(pc.dim, footer.join("  •  ")));

  lines.push(color(pc.dim, SEPARATOR));

  return lines.join("\n");
}

export function exportMarkdown(data: StandupData): string {
  const lines: string[] = [];
  lines.push(`# Standup — ${data.date}`);
  lines.push("");

  // Yesterday
  lines.push("## Yesterday");
  lines.push("");
  if (data.yesterday.sessions.length === 0) {
    lines.push("No sessions yesterday — fresh start today.");
  } else {
    lines.push(`**${data.yesterday.totalTasks} tasks** across ${data.yesterday.sessions.length} session(s)`);
    lines.push("");
    for (const s of data.yesterday.sessions) {
      const rework = s.reworkCount > 0 ? ` (${s.reworkCount} rework)` : "";
      lines.push(`- **${s.goal}** — ${s.tasksCompleted} tasks${rework}`);
    }
    if (data.yesterday.teamLearnings.length > 0) {
      lines.push("");
      lines.push("### Learnings");
      lines.push("");
      for (const l of data.yesterday.teamLearnings) {
        lines.push(`- ${l}`);
      }
    }
  }

  lines.push("");

  // Blocked
  lines.push("## Blocked");
  lines.push("");
  if (data.blocked.length === 0) {
    lines.push("Nothing blocked — clean slate.");
  } else {
    for (const b of data.blocked) {
      const priority = b.priority === "high" ? "HIGH" : b.priority === "medium" ? "MEDIUM" : "LOW";
      lines.push(`- **[${priority}]** ${b.description}`);
    }
  }

  lines.push("");

  // Suggested
  lines.push("## Suggested Next Steps");
  lines.push("");
  if (data.suggested.length === 0) {
    lines.push("No suggested next steps — define your own goal.");
  } else {
    for (const s of data.suggested) {
      lines.push(`- ${s.description}`);
      lines.push(`  - _${s.reasoning}_`);
    }
  }

  lines.push("");

  // Footer
  lines.push("---");
  lines.push("");
  const footerParts: string[] = [];
  if (data.streak > 0) footerParts.push(`${data.streak}-day streak`);
  if (data.globalPatternsCount > 0) footerParts.push(`${data.globalPatternsCount} global patterns`);
  lines.push(footerParts.join(" | "));
  lines.push("");

  return lines.join("\n");
}
