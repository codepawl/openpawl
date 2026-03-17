/**
 * CLI journal subcommands — list, search, show, reconsider, export.
 */

import pc from "picocolors";
import { logger } from "../core/logger.js";
import { DecisionStore } from "../journal/store.js";
import type { Decision } from "../journal/types.js";
import { GlobalMemoryManager } from "../memory/global/store.js";

async function getStore(): Promise<DecisionStore | null> {
  try {
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");
    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (!embedder) return null;

    const globalMgr = new GlobalMemoryManager();
    await globalMgr.init(embedder);
    const db = globalMgr.getDb();
    if (!db) return null;

    const store = new DecisionStore();
    await store.init(db);
    return store;
  } catch {
    return null;
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatDecisionShort(d: Decision): string {
  const date = formatDate(d.capturedAt);
  const conf = (d.confidence * 100).toFixed(0);
  const statusBadge = d.status === "superseded"
    ? pc.yellow(" [superseded]")
    : d.status === "reconsidered"
      ? pc.blue(" [reconsidered]")
      : "";
  return [
    `[${pc.dim(date)}] ${pc.bold(d.decision)}${statusBadge}`,
    `  Recommended by: ${d.recommendedBy} | Confidence: ${conf}%`,
    `  Session: ${d.sessionId.slice(0, 16)} — "${d.goalContext.slice(0, 50)}${d.goalContext.length > 50 ? "..." : ""}"`,
    `  "${d.reasoning.slice(0, 80)}${d.reasoning.length > 80 ? "..." : ""}"`,
  ].join("\n");
}

function formatDecisionFull(d: Decision): string {
  const date = formatDate(d.capturedAt);
  const lines = [
    pc.cyan(`Decision: ${d.decision}`),
    `Date: ${date}`,
    `Topic: ${d.topic}`,
    `Status: ${d.status}`,
    `Recommended by: ${d.recommendedBy}`,
    `Confidence: ${(d.confidence * 100).toFixed(0)}%`,
    `Session: ${d.sessionId}`,
    `Run: ${d.runIndex}`,
    `Task: ${d.taskId}`,
    `Goal: ${d.goalContext}`,
    `Tags: ${d.tags.join(", ") || "(none)"}`,
    "",
    pc.bold("Reasoning:"),
    d.reasoning,
  ];
  if (d.supersededBy) {
    lines.push("", pc.yellow(`Superseded by: ${d.supersededBy}`));
  }
  return lines.join("\n");
}

function parseSinceDays(since: string): number {
  const match = since.match(/^(\d+)\s*([dhw])$/i);
  if (!match) return 30;
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  if (unit === "h") return Math.max(1, Math.ceil(n / 24));
  if (unit === "w") return n * 7;
  return n; // days
}

async function listDecisions(args: string[]): Promise<void> {
  const store = await getStore();
  if (!store) {
    logger.error("Could not initialize decision store. Run `teamclaw setup` first.");
    return;
  }

  let decisions: Decision[];

  const sinceIdx = args.indexOf("--since");
  const sessionIdx = args.indexOf("--session");
  const agentIdx = args.indexOf("--agent");

  if (sinceIdx >= 0 && args[sinceIdx + 1]) {
    const days = parseSinceDays(args[sinceIdx + 1]!);
    decisions = await store.getRecentDecisions(days);
  } else if (sessionIdx >= 0 && args[sessionIdx + 1]) {
    decisions = await store.getDecisionsBySession(args[sessionIdx + 1]!);
  } else {
    decisions = await store.getAll();
  }

  if (agentIdx >= 0 && args[agentIdx + 1]) {
    const agentFilter = args[agentIdx + 1]!.toLowerCase();
    decisions = decisions.filter(
      (d) => d.recommendedBy.toLowerCase().includes(agentFilter),
    );
  }

  if (decisions.length === 0) {
    logger.plain("No decisions found.");
    return;
  }

  logger.plain(`${decisions.length} decision(s):\n`);
  for (const d of decisions) {
    logger.plain(formatDecisionShort(d));
    logger.plain("");
  }
}

async function searchDecisions(args: string[]): Promise<void> {
  const query = args.join(" ").trim();
  if (!query) {
    logger.error("Usage: teamclaw journal search <query>");
    return;
  }

  const store = await getStore();
  if (!store) {
    logger.error("Could not initialize decision store.");
    return;
  }

  const results = await store.searchDecisions(query);
  if (results.length === 0) {
    logger.plain(`No decisions found matching "${query}".`);
    return;
  }

  logger.plain(`${results.length} decision(s) found matching "${query}":\n`);
  for (const d of results) {
    logger.plain(formatDecisionShort(d));
    logger.plain("");
  }
}

async function showDecision(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    logger.error("Usage: teamclaw journal show <decisionId | sessionId>");
    return;
  }

  const store = await getStore();
  if (!store) {
    logger.error("Could not initialize decision store.");
    return;
  }

  // Try by decision ID first
  const byId = await store.getById(id);
  if (byId) {
    logger.plain(formatDecisionFull(byId));
    return;
  }

  // Try by session ID
  const bySession = await store.getDecisionsBySession(id);
  if (bySession.length > 0) {
    logger.plain(`${bySession.length} decision(s) from session ${id}:\n`);
    for (const d of bySession) {
      logger.plain(formatDecisionShort(d));
      logger.plain("");
    }
    return;
  }

  logger.error(`No decision or session found with ID "${id}".`);
}

async function reconsiderDecision(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    logger.error("Usage: teamclaw journal reconsider <decisionId>");
    return;
  }

  const store = await getStore();
  if (!store) {
    logger.error("Could not initialize decision store.");
    return;
  }

  const ok = await store.markReconsidered(id);
  if (ok) {
    logger.success(`Decision ${id} marked as reconsidered.`);
  } else {
    logger.error(`Decision "${id}" not found.`);
  }
}

async function exportJournal(): Promise<void> {
  const store = await getStore();
  if (!store) {
    logger.error("Could not initialize decision store.");
    return;
  }

  const all = await store.getAll();
  if (all.length === 0) {
    logger.plain("No decisions to export.");
    return;
  }

  const active = all.filter((d) => d.status === "active");
  const superseded = all.filter((d) => d.status === "superseded");
  const reconsidered = all.filter((d) => d.status === "reconsidered");

  const formatMd = (d: Decision): string => {
    const date = formatDate(d.capturedAt);
    return [
      `### ${d.decision}`,
      `**Date:** ${date} | **Session:** ${d.goalContext.slice(0, 60)}`,
      `**Recommended by:** ${d.recommendedBy} | **Confidence:** ${(d.confidence * 100).toFixed(0)}%`,
      `**Reasoning:** ${d.reasoning}`,
      d.supersededBy ? `**Superseded by:** ${d.supersededBy}` : "",
      "",
      "---",
      "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const lines = [
    "# TeamClaw Decision Journal",
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    "",
  ];

  if (active.length > 0) {
    lines.push(`## Active Decisions (${active.length})`, "");
    for (const d of active) lines.push(formatMd(d));
  }

  if (superseded.length > 0) {
    lines.push(`## Superseded Decisions (${superseded.length})`, "");
    for (const d of superseded) lines.push(formatMd(d));
  }

  if (reconsidered.length > 0) {
    lines.push(`## Reconsidered Decisions (${reconsidered.length})`, "");
    for (const d of reconsidered) lines.push(formatMd(d));
  }

  const output = lines.join("\n");
  const { writeFile } = await import("node:fs/promises");
  const outPath = "DECISION_JOURNAL.md";
  await writeFile(outPath, output, "utf-8");
  logger.success(`Exported ${all.length} decision(s) to ${outPath}`);
}

export async function runJournalCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    logger.plain([
      pc.bold("teamclaw journal") + " — Decision journal",
      "",
      "Subcommands:",
      "  list                          All decisions, newest first",
      "  list --since 7d               Last 7 days",
      "  list --session <id>           Decisions from specific session",
      "  list --agent tech-lead        Decisions by specific agent",
      "  search <query>                Keyword search",
      "  show <decisionId|sessionId>   Full decision detail",
      "  reconsider <decisionId>       Mark decision as reconsidered",
      "  export                        Export all as markdown",
    ].join("\n"));
    return;
  }

  switch (sub) {
    case "list":
      await listDecisions(args.slice(1));
      break;
    case "search":
      await searchDecisions(args.slice(1));
      break;
    case "show":
      await showDecision(args.slice(1));
      break;
    case "reconsider":
      await reconsiderDecision(args.slice(1));
      break;
    case "export":
      await exportJournal();
      break;
    default:
      logger.error(`Unknown journal subcommand: ${sub}. Run 'teamclaw journal --help' for usage.`);
  }
}
