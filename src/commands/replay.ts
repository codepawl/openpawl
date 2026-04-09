/**
 * CLI commands for session replay.
 *
 * openpawl replay list [--limit N]
 * openpawl replay <sessionId> [--run N] [--from <node>] [--fast] [--speed N] [--patch <file>] [--live-after]
 * openpawl replay diff <sessionIdA> <sessionIdB>
 * openpawl replay export <sessionId>
 * openpawl replay tag <sessionId> <label>
 * openpawl replay untag <sessionId>
 * openpawl replay prune
 * openpawl replay clean
 */

import { existsSync, readFileSync } from "node:fs";
import pc from "picocolors";
import { logger } from "../core/logger.js";
import {
  listSessions,
  getSession,
  replayToTerminal,
  diffSessions,
  tagSession,
  untagSession,
  pruneOldSessions,
  deleteAllSessions,
  exportSession,
} from "../replay/index.js";
import type { ReplayOptions, PatchFile, SessionDiff } from "../replay/types.js";

export async function runReplayCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (sub === "list" || sub === "ls") {
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) : undefined;
    runList(limit);
    return;
  }

  if (sub === "diff") {
    await runDiff(args[1], args[2]);
    return;
  }

  if (sub === "export") {
    await runExport(args[1]);
    return;
  }

  if (sub === "tag") {
    runTag(args[1], args.slice(2).join(" "));
    return;
  }

  if (sub === "untag") {
    runUntag(args[1]);
    return;
  }

  if (sub === "prune") {
    runPrune();
    return;
  }

  if (sub === "clean") {
    await runClean();
    return;
  }

  // Default: treat first arg as sessionId for replay
  await runReplay(args);
}

function printHelp(): void {
  const lines = [
    "",
    pc.bold("openpawl replay") + " — Replay and inspect past sessions",
    "",
    pc.bold("Commands:"),
    "  " + pc.green("list") + "                          List recorded sessions",
    "  " + pc.green("<sessionId>") + "                   Replay a session",
    "  " + pc.green("diff <id1> <id2>") + "              Compare two sessions",
    "  " + pc.green("export <sessionId>") + "            Export recording as JSON",
    "  " + pc.green("tag <sessionId> <label>") + "       Tag session (prevents auto-prune)",
    "  " + pc.green("untag <sessionId>") + "             Remove tag",
    "  " + pc.green("prune") + "                         Prune old recordings",
    "  " + pc.green("clean") + "                         Delete all recordings",
    "",
    pc.bold("Replay options:"),
    "  " + pc.green("--run <N>") + "       Replay specific run in multi-run session",
    "  " + pc.green("--from <node>") + "   Start replay from a specific node",
    "  " + pc.green("--fast") + "          Instant playback (no timing delays)",
    "  " + pc.green("--speed <N>") + "     Speed multiplier (default: 1.0)",
    "  " + pc.green("--patch <file>") + "  Apply patch file during replay",
    "  " + pc.green("--live-after") + "    Re-execute live after patched node",
    "  " + pc.green("--web") + "           Open dashboard during replay",
    "",
    "Examples:",
    pc.dim("  openpawl replay list"),
    pc.dim("  openpawl replay sess_abc123 --fast"),
    pc.dim("  openpawl replay sess_abc123 --from coordinator --speed 2"),
    pc.dim("  openpawl replay diff sess_abc123 sess_def456"),
    "",
  ];
  console.log(lines.join("\n"));
}

function runList(limit?: number): void {
  const sessions = listSessions(limit);

  if (sessions.length === 0) {
    logger.plain("No recorded sessions found.");
    logger.plain(pc.dim("Sessions are recorded automatically during work runs."));
    return;
  }

  const header = [
    pad("ID", 24),
    pad("Goal", 35),
    pad("Date", 12),
    pad("Runs", 5),
    "Tag",
  ].join("");

  logger.plain(pc.bold(header));
  logger.plain("─".repeat(85));

  for (const s of sessions) {
    const id = pad(s.sessionId.slice(0, 22), 24);
    const goal = pad(s.goal.slice(0, 33), 35);
    const date = pad(new Date(s.createdAt).toLocaleDateString(), 12);
    const runs = pad(String(s.totalRuns), 5);
    const tag = s.tag ? pc.cyan(s.tag) : "";
    logger.plain(`${id}${goal}${date}${runs}${tag}`);
  }
}

async function runReplay(args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    logger.error("Usage: openpawl replay <sessionId>");
    process.exit(1);
  }

  const session = getSession(sessionId);
  if (!session) {
    logger.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }

  // Parse options
  const options: ReplayOptions = {
    sessionId,
    speed: 1.0,
  };

  const runIdx = args.indexOf("--run");
  if (runIdx >= 0) options.runIndex = parseInt(args[runIdx + 1] ?? "1", 10);

  const fromIdx = args.indexOf("--from");
  if (fromIdx >= 0) options.fromNode = args[fromIdx + 1];

  if (args.includes("--fast")) options.speed = 0;

  const speedIdx = args.indexOf("--speed");
  if (speedIdx >= 0) options.speed = parseFloat(args[speedIdx + 1] ?? "1");

  const patchIdx = args.indexOf("--patch");
  if (patchIdx >= 0) {
    const patchPath = args[patchIdx + 1];
    if (patchPath && existsSync(patchPath)) {
      const patchFile = JSON.parse(readFileSync(patchPath, "utf-8")) as PatchFile;
      options.patch = patchFile.patches;
    } else {
      logger.error(`Patch file not found: ${patchPath}`);
      process.exit(1);
    }
  }

  if (args.includes("--live-after")) options.liveAfter = true;

  logger.plain(`Replaying: ${pc.bold(session.goal)}`);
  logger.plain(`Session: ${sessionId} | Runs: ${session.totalRuns} | Speed: ${options.speed === 0 ? "instant" : `${options.speed}x`}`);
  logger.plain("");

  const ok = await replayToTerminal(options);
  if (!ok) process.exit(1);
}

async function runDiff(idA?: string, idB?: string): Promise<void> {
  if (!idA || !idB) {
    logger.error("Usage: openpawl replay diff <sessionId1> <sessionId2>");
    process.exit(1);
  }

  const diff = await diffSessions(idA, idB);
  if (!diff) {
    logger.error("One or both sessions not found.");
    process.exit(1);
  }

  printDiff(diff);
}

function printDiff(diff: SessionDiff): void {
  logger.plain(`Comparing ${pc.bold(diff.sessionA)} vs ${pc.bold(diff.sessionB)}`);
  logger.plain("─".repeat(60));
  logger.plain(`Goal:        ${diff.goalSame ? "same" : `"${diff.goalA}" vs "${diff.goalB}"`}`);
  logger.plain(`Team:        ${diff.teamSame ? "same" : `${diff.teamA.join(",")} vs ${diff.teamB.join(",")}`}`);
  logger.plain(`Tasks:       ${diff.taskCountA} vs ${diff.taskCountB}${diff.taskCountA !== diff.taskCountB ? ` (${formatDelta(diff.taskCountB - diff.taskCountA)} tasks)` : ""}`);
  logger.plain(`Avg conf:    ${diff.avgConfidenceA.toFixed(2)} vs ${diff.avgConfidenceB.toFixed(2)}${formatDelta(diff.avgConfidenceB - diff.avgConfidenceA, true)}`);
  logger.plain(`Duration:    ${formatMs(diff.durationA)} vs ${formatMs(diff.durationB)}`);

  if (diff.changedNodes.length > 0) {
    logger.plain("");
    logger.plain(pc.bold("Changed nodes:"));
    for (const node of diff.changedNodes) {
      const icon = node.changeType === "added" ? "+" : node.changeType === "removed" ? "-" : "~";
      logger.plain(`  ${icon} ${pad(node.nodeId, 20)} ${node.details}`);
    }
  }
}

async function runExport(sessionId?: string): Promise<void> {
  if (!sessionId) {
    logger.error("Usage: openpawl replay export <sessionId>");
    process.exit(1);
  }

  const data = await exportSession(sessionId);
  if (!data.session) {
    logger.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
}

function runTag(sessionId?: string, label?: string): void {
  if (!sessionId || !label?.trim()) {
    logger.error("Usage: openpawl replay tag <sessionId> <label>");
    process.exit(1);
  }
  if (tagSession(sessionId, label.trim())) {
    logger.success(`Tagged ${sessionId}: "${label.trim()}"`);
  } else {
    logger.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }
}

function runUntag(sessionId?: string): void {
  if (!sessionId) {
    logger.error("Usage: openpawl replay untag <sessionId>");
    process.exit(1);
  }
  if (untagSession(sessionId)) {
    logger.success(`Untagged ${sessionId}`);
  } else {
    logger.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }
}

function runPrune(): void {
  const { pruned } = pruneOldSessions();
  if (pruned.length === 0) {
    logger.plain("No sessions to prune.");
  } else {
    logger.success(`Pruned ${pruned.length} session(s): ${pruned.join(", ")}`);
  }
}

async function runClean(): Promise<void> {
  const canPrompt = Boolean(process.stdout.isTTY && process.stderr.isTTY);

  if (canPrompt) {
    const { text, isCancel: isCancelled } = await import("@clack/prompts");
    const confirmation = await text({
      message: 'Type "delete all recordings" to confirm:',
    });
    if (isCancelled(confirmation) || confirmation !== "delete all recordings") {
      logger.plain("Cancelled.");
      return;
    }
  }

  const count = deleteAllSessions();
  logger.success(`Deleted ${count} session recording(s).`);
}

// Helpers

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(1, w - s.length));
}

function formatDelta(delta: number, isDecimal = false, prefix = ""): string {
  if (Math.abs(delta) < 0.001) return "";
  const sign = delta > 0 ? "+" : "";
  const value = isDecimal ? delta.toFixed(2) : String(Math.round(delta));
  return ` (${sign}${prefix}${value})`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return min > 0 ? `${min}m${s.toString().padStart(2, "0")}s` : `${sec}s`;
}
