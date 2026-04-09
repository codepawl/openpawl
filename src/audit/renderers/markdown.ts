/**
 * Markdown renderer for audit trails.
 * Produces valid CommonMark output.
 */

import type { AuditTrail, MultiRunSummary } from "../types.js";
import type { RenderOptions } from "./types.js";
import { DEFAULT_RENDER_OPTIONS } from "./types.js";

export function renderAuditMarkdown(
  audit: AuditTrail,
  opts: Partial<RenderOptions> = {},
): string {
  const options = { ...DEFAULT_RENDER_OPTIONS, ...opts };
  const sections: string[] = [];

  sections.push(renderHeader(audit));
  sections.push(renderSummary(audit));

  if (options.sections.decisionLog) {
    sections.push(renderDecisionLog(audit, options));
  }
  if (options.sections.approvalHistory) {
    sections.push(renderApprovalHistory(audit));
  }
  if (options.sections.costBreakdown) {
    sections.push(renderCostBreakdown(audit));
  }
  if (options.sections.memoryUsage) {
    sections.push(renderMemoryUsage(audit));
  }
  if (options.sections.agentPerformance) {
    sections.push(renderAgentPerformance(audit));
  }
  if (audit.vibeScore) {
    sections.push(renderVibeScore(audit));
  }
  if (audit.cachePerformance) {
    sections.push(renderCachePerformance(audit));
  }
  if (audit.providerStats) {
    sections.push(renderProviderUsage(audit));
  }

  return sections.join("\n\n---\n\n") + "\n";
}

function renderHeader(audit: AuditTrail): string {
  const date = new Date(audit.startedAt).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const duration = formatDuration(audit.durationMs);

  return [
    "# OpenPawl Audit Trail",
    "",
    `**Session:** ${audit.sessionId}`,
    `**Goal:** ${audit.goal}`,
    `**Date:** ${date}`,
    `**Duration:** ${duration}`,
    `**Total Tokens:** ${audit.summary.totalTokensInput.toLocaleString()} in / ${audit.summary.totalTokensOutput.toLocaleString()} out`,
    `**Team:** ${audit.teamComposition.join(", ")}`,
  ].join("\n");
}

function renderSummary(audit: AuditTrail): string {
  const s = audit.summary;
  return [
    "## Sprint Summary",
    "",
    `- Tasks completed: ${s.tasksCompleted}`,
    `- Tasks failed: ${s.tasksFailed}`,
    `- Auto-approved: ${s.autoApproved}`,
    `- User-approved: ${s.userApproved}`,
    `- Rejected: ${s.rejected}`,
    `- Escalated: ${s.escalated}`,
    `- Average confidence: ${s.averageConfidence.toFixed(2)}`,
  ].join("\n");
}

function renderDecisionLog(audit: AuditTrail, options: RenderOptions): string {
  if (audit.decisionLog.length === 0) {
    return "## Decision Log\n\nNo decision events recorded.";
  }

  const lines = ["## Decision Log", ""];

  for (const entry of audit.decisionLog) {
    const time = new Date(entry.timestamp).toTimeString().slice(0, 8);
    lines.push(`### ${time} — ${entry.nodeId}`);
    lines.push(entry.decision);

    if (entry.data.confidence != null) {
      const conf = entry.data.confidence as number;
      const icon = conf >= 0.85 ? "auto-approved" : conf >= 0.6 ? "sent to QA review" : "needs rework";
      lines.push(`Confidence: ${conf.toFixed(2)} ${icon}`);
    }
    if (entry.data.durationMs) {
      lines.push(`Duration: ${formatDuration(entry.data.durationMs as number)}`);
    }
    if (entry.data.tokensUsed) {
      lines.push(`Tokens: ${(entry.data.tokensUsed as number).toLocaleString()}`);
    }

    if (options.includePrompts && entry.data.prompt) {
      let prompt = entry.data.prompt as string;
      if (prompt.length > options.promptMaxLength) {
        prompt = prompt.slice(0, options.promptMaxLength) + "\n[truncated]";
      }
      lines.push("", "```", prompt, "```");
    }

    lines.push("");
  }

  return lines.join("\n");
}

function renderApprovalHistory(audit: AuditTrail): string {
  if (audit.approvalHistory.length === 0) {
    return "## Approval History\n\nNo approval events recorded.";
  }

  const lines = [
    "## Approval History",
    "",
    "| Task | Action | By | Confidence | Feedback |",
    "|------|--------|----|------------|----------|",
  ];

  for (const entry of audit.approvalHistory) {
    const conf = entry.confidence != null ? entry.confidence.toFixed(2) : "—";
    const feedback = entry.feedback ? `"${entry.feedback.slice(0, 50)}"` : "—";
    lines.push(`| ${entry.taskId} | ${entry.action} | ${entry.by} | ${conf} | ${feedback} |`);
  }

  return lines.join("\n");
}

function renderCostBreakdown(audit: AuditTrail): string {
  if (audit.costBreakdown.length === 0) {
    return "## Token Usage\n\nNo token data available.";
  }

  const lines = [
    "## Token Usage",
    "",
    "| Agent | Tasks | Tokens |",
    "|-------|-------|--------|",
  ];

  let totalTasks = 0;
  let totalTokens = 0;

  for (const entry of audit.costBreakdown) {
    const tokens = entry.tokensInput + entry.tokensOutput;
    lines.push(`| ${entry.agent} | ${entry.tasks} | ${tokens.toLocaleString()} |`);
    totalTasks += entry.tasks;
    totalTokens += tokens;
  }

  lines.push(`| **Total** | **${totalTasks}** | **${totalTokens.toLocaleString()}** |`);

  return lines.join("\n");
}

function renderMemoryUsage(audit: AuditTrail): string {
  const m = audit.memoryUsage;
  return [
    "## Memory Usage",
    "",
    `- Success patterns retrieved: ${m.successPatternsRetrieved}`,
    `- Failure lessons retrieved: ${m.failureLessonsRetrieved}`,
    `- New patterns stored: ${m.newPatternsStored}`,
    `- Global patterns promoted: ${m.globalPatternsPromoted}`,
  ].join("\n");
}

function renderAgentPerformance(audit: AuditTrail): string {
  if (audit.agentPerformance.length === 0) {
    return "## Agent Performance\n\nNo performance data available.";
  }

  const lines = [
    "## Agent Performance This Run",
    "",
    "| Agent | Tasks | Avg Confidence | vs Profile |",
    "|-------|-------|----------------|------------|",
  ];

  for (const entry of audit.agentPerformance) {
    const vs = entry.vsProfile != null
      ? `${entry.vsProfile >= 0 ? "+" : ""}${entry.vsProfile.toFixed(2)} ${entry.trend === "up" ? "↑" : entry.trend === "down" ? "↓" : "→"}`
      : "—";
    lines.push(`| ${entry.agent} | ${entry.tasks} | ${entry.avgConfidence.toFixed(2)} | ${vs} |`);
  }

  return lines.join("\n");
}

function renderVibeScore(audit: AuditTrail): string {
  const v = audit.vibeScore!;
  const lines = [
    "## Collaboration Score",
    "",
    `**Overall:** ${v.overall}/100`,
    "",
    "| Dimension | Score |",
    "|-----------|-------|",
    `| Team Trust | ${v.teamTrust.toFixed(1)}/25 |`,
    `| Review Engagement | ${v.reviewEngagement.toFixed(1)}/25 |`,
    `| Warning Response | ${v.warningResponse.toFixed(1)}/25 |`,
    `| Confidence Alignment | ${v.confidenceAlignment.toFixed(1)}/25 |`,
  ];

  if (v.patterns.length > 0) {
    lines.push("", "**Patterns:**");
    for (const p of v.patterns) {
      lines.push(`- ${p}`);
    }
  }

  if (v.tip) {
    lines.push("", `**Tip:** ${v.tip}`);
  }

  return lines.join("\n");
}

function renderCachePerformance(audit: AuditTrail): string {
  const c = audit.cachePerformance!;
  const timeSaved = c.timeSavedMs < 1000
    ? `${c.timeSavedMs}ms`
    : `${(c.timeSavedMs / 1000).toFixed(0)}s`;
  return [
    "## Cache Performance",
    "",
    `- Hit rate: ${Math.round(c.hitRate * 100)}%`,
    `- Entries used: ${c.entriesUsed}`,
    `- Time saved: ${timeSaved}`,
  ].join("\n");
}

function renderProviderUsage(audit: AuditTrail): string {
  const p = audit.providerStats!;
  const lines = ["## Provider Usage", ""];
  for (const [key, val] of Object.entries(p)) {
    if (key === "fallbacksTriggered") continue;
    if (typeof val === "object" && val) {
      const entry = val as { requests: number; failures: number };
      lines.push(`- ${key}: ${entry.requests} requests, ${entry.failures} failures`);
    }
  }
  lines.push(`- Fallbacks triggered: ${p.fallbacksTriggered}`);
  return lines.join("\n");
}

/** Render a multi-run summary as markdown. */
export function renderMultiRunSummary(summary: MultiRunSummary): string {
  const lines = [
    "# OpenPawl Multi-Run Summary",
    "",
    `**Session:** ${summary.sessionId}`,
    `**Total Runs:** ${summary.totalRuns}`,
    `**Total Duration:** ${formatDuration(summary.totalDurationMs)}`,
    `**Total Tokens:** ${((summary.runs.reduce((s, r) => s + r.summary.totalTokensInput + r.summary.totalTokensOutput, 0)) / 1000).toFixed(1)}k`,
    "",
    "---",
    "",
    "## Confidence Trend",
    "",
  ];

  // ASCII confidence trend
  for (let i = 0; i < summary.confidenceTrend.length; i++) {
    const conf = summary.confidenceTrend[i];
    const bar = "█".repeat(Math.round(conf * 20));
    lines.push(`Run ${i + 1}: ${bar} ${conf.toFixed(2)}`);
  }

  if (summary.patternsPromoted.length > 0) {
    lines.push("", "## Patterns Promoted to Global Memory", "");
    for (const pattern of summary.patternsPromoted) {
      lines.push(`- ${pattern}`);
    }
  }

  return lines.join("\n") + "\n";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min > 0) return `${min}m ${s.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}
