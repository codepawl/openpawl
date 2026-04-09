/**
 * CLI commands for audit trail export.
 *
 * openpawl audit <sessionId>                    Export last run as markdown
 * openpawl audit <sessionId> --run N            Export specific run
 * openpawl audit <sessionId> --format pdf       Export as PDF
 * openpawl audit <sessionId> --format both      Export both formats
 * openpawl audit <sessionId> --output ./dir     Custom output directory
 * openpawl audit <sessionId> --include-prompts  Include raw agent prompts
 * openpawl audit <sessionId> --all-runs         Export all runs separately
 * openpawl audit <sessionId> --summary          Multi-run summary only
 * openpawl audit list                           List exported audits
 * openpawl audit open <sessionId>               Open audit file
 */

import { existsSync, readdirSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import pc from "picocolors";
import { logger } from "../core/logger.js";
import { getSession, readRecordingEvents } from "../replay/index.js";
import {
  buildAuditTrail,
  renderAuditMarkdown,
  renderMultiRunSummary,
  renderLearningProgression,
} from "../audit/index.js";
import type { AuditTrail, MultiRunSummary } from "../audit/types.js";
import { extractRunSnapshot } from "../diff/engine.js";
import { buildDiffChain } from "../diff/chain.js";
import type { RunSnapshot } from "../diff/types.js";

const SESSIONS_DIR = path.join(os.homedir(), ".openpawl", "sessions");

export async function runAuditCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (sub === "list") {
    runList();
    return;
  }

  if (sub === "open") {
    await runOpen(args[1]);
    return;
  }

  // Default: treat first arg as sessionId
  await runExport(args);
}

function printHelp(): void {
  const lines = [
    "",
    pc.bold("openpawl audit") + " — Export audit trails for past sessions",
    "",
    pc.bold("Commands:"),
    "  " + pc.green("<sessionId>") + "                   Export audit trail (default: markdown)",
    "  " + pc.green("list") + "                          List exported audits",
    "  " + pc.green("open <sessionId>") + "              Open audit in default app",
    "",
    pc.bold("Options:"),
    "  " + pc.green("--run <N>") + "       Export specific run",
    "  " + pc.green("--format <fmt>") + "  Output format: markdown, pdf, both (default: markdown)",
    "  " + pc.green("--output <dir>") + "  Custom output directory",
    "  " + pc.green("--include-prompts") + " Include raw agent prompts",
    "  " + pc.green("--all-runs") + "    Export all runs separately",
    "  " + pc.green("--summary") + "     Multi-run summary only",
    "",
    "Examples:",
    pc.dim("  openpawl audit sess_abc123"),
    pc.dim("  openpawl audit sess_abc123 --format pdf"),
    pc.dim("  openpawl audit sess_abc123 --all-runs --include-prompts"),
    "",
  ];
  console.log(lines.join("\n"));
}

async function runExport(args: string[]): Promise<void> {
  const sessionId = args[0];
  if (!sessionId) {
    logger.error("Usage: openpawl audit <sessionId>");
    process.exit(1);
  }

  const session = getSession(sessionId);
  if (!session) {
    logger.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }

  // Parse options
  const formatIdx = args.indexOf("--format");
  const format = formatIdx >= 0 ? (args[formatIdx + 1] ?? "markdown") : "markdown";

  const outputIdx = args.indexOf("--output");
  const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : path.join(SESSIONS_DIR, sessionId);

  const runIdx = args.indexOf("--run");
  const runIndex = runIdx >= 0 ? parseInt(args[runIdx + 1] ?? "1", 10) : 0;

  const includePrompts = args.includes("--include-prompts");
  const allRuns = args.includes("--all-runs");
  const summaryOnly = args.includes("--summary");

  await mkdir(outputDir!, { recursive: true });

  // Build empty team for audit (we don't have team data in session index)
  const team: { id: string; name: string; role_id: string; traits: Record<string, unknown>; worker_url: string | null }[] = [];

  if (summaryOnly && session.totalRuns > 1) {
    // Multi-run summary
    const audits: AuditTrail[] = [];
    for (let i = 1; i <= session.totalRuns; i++) {
      const audit = await buildAuditTrail(sessionId, i, {
        user_goal: session.goal,
        average_confidence: session.averageConfidence,
      }, session.createdAt, session.completedAt, team);
      audits.push(audit);
    }

    const summary: MultiRunSummary = {
      sessionId,
      totalRuns: session.totalRuns,
      runs: audits,
      confidenceTrend: audits.map((a) => a.summary.averageConfidence),
      patternsPromoted: [],
      totalDurationMs: session.completedAt - session.createdAt,
    };

    let md = renderMultiRunSummary(summary);

    // Append learning progression diff if multiple runs
    if (session.totalRuns >= 2) {
      try {
        const events = await readRecordingEvents(sessionId);
        const snapshots: RunSnapshot[] = [];
        for (let i = 1; i <= session.totalRuns; i++) {
          const runEvents = events.filter((e) => e.runIndex === i);
          const exits = runEvents.filter((e) => e.phase === "exit");
          const enters = runEvents.filter((e) => e.phase === "enter");
          const state = exits[exits.length - 1]?.stateAfter ?? {};
          const start = enters[0]?.timestamp ?? session.createdAt;
          const end = exits[exits.length - 1]?.timestamp ?? session.completedAt;
          snapshots.push(extractRunSnapshot(sessionId, i, state, start, end));
        }
        const chain = buildDiffChain(snapshots);
        md += "\n\n---\n\n" + renderLearningProgression(chain);
      } catch {
        // Learning progression is optional — skip if events unavailable
      }
    }

    const outPath = path.join(outputDir!, "summary.md");
    await writeFile(outPath, md, "utf-8");
    logger.success(`Multi-run summary exported: ${outPath}`);
    return;
  }

  if (allRuns && session.totalRuns > 1) {
    for (let i = 1; i <= session.totalRuns; i++) {
      const audit = await buildAuditTrail(sessionId, i, {
        user_goal: session.goal,
        average_confidence: session.averageConfidence,
      }, session.createdAt, session.completedAt, team);

      await exportAudit(audit, format, outputDir!, includePrompts, i);
    }
    logger.success(`Exported ${session.totalRuns} audit trails to ${outputDir}`);
    return;
  }

  // Single run export
  const audit = await buildAuditTrail(sessionId, runIndex, {
    user_goal: session.goal,
    average_confidence: session.averageConfidence,
  }, session.createdAt, session.completedAt, team);

  await exportAudit(audit, format, outputDir!, includePrompts);
}

async function exportAudit(
  audit: AuditTrail,
  format: string,
  outputDir: string,
  includePrompts: boolean,
  runIndex?: number,
): Promise<void> {
  const suffix = runIndex ? `-run${runIndex}` : "";

  if (format === "markdown" || format === "both") {
    const md = renderAuditMarkdown(audit, {
      includePrompts,
      promptMaxLength: 2000,
    });
    const outPath = path.join(outputDir, `audit${suffix}.md`);
    await writeFile(outPath, md, "utf-8");
    logger.success(`Markdown audit: ${outPath}`);
  }

  if (format === "pdf" || format === "both") {
    try {
      const { renderAuditPDF } = await import("../audit/renderers/pdf.js");
      const buffer = await renderAuditPDF(audit, {
        includePrompts,
        promptMaxLength: 2000,
      });
      const outPath = path.join(outputDir, `audit${suffix}.pdf`);
      await writeFile(outPath, buffer);
      logger.success(`PDF audit: ${outPath}`);
    } catch (err) {
      logger.error(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function runList(): void {
  if (!existsSync(SESSIONS_DIR)) {
    logger.plain("No sessions found.");
    return;
  }

  const dirs = readdirSync(SESSIONS_DIR).filter((d) => {
    const sessionDir = path.join(SESSIONS_DIR, d);
    return existsSync(path.join(sessionDir, "audit.md")) || existsSync(path.join(sessionDir, "audit.pdf"));
  });

  if (dirs.length === 0) {
    logger.plain("No exported audits found.");
    logger.plain(pc.dim("Export one with: openpawl audit <sessionId>"));
    return;
  }

  logger.plain(pc.bold("Exported Audits:"));
  logger.plain("─".repeat(60));
  for (const dir of dirs) {
    const sessionDir = path.join(SESSIONS_DIR, dir);
    const hasMd = existsSync(path.join(sessionDir, "audit.md"));
    const hasPdf = existsSync(path.join(sessionDir, "audit.pdf"));
    const formats = [hasMd ? "md" : "", hasPdf ? "pdf" : ""].filter(Boolean).join(", ");
    logger.plain(`  ${dir}  [${formats}]`);
  }
}

async function runOpen(sessionId?: string): Promise<void> {
  if (!sessionId) {
    logger.error("Usage: openpawl audit open <sessionId>");
    process.exit(1);
  }

  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  const mdPath = path.join(sessionDir, "audit.md");
  const pdfPath = path.join(sessionDir, "audit.pdf");

  const filePath = existsSync(pdfPath) ? pdfPath : existsSync(mdPath) ? mdPath : null;
  if (!filePath) {
    logger.error(`No audit file found for ${sessionId}. Run: openpawl audit ${sessionId}`);
    process.exit(1);
  }

  // Open with default app
  const { exec } = await import("node:child_process");
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${filePath}"`);
  logger.success(`Opened: ${filePath}`);
}
