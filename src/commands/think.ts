/**
 * CLI command: openpawl think
 * Lightweight structured thinking mode — rubber duck debugging.
 */

import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";
import { logger } from "../core/logger.js";
import { isCancel, select, text } from "@clack/prompts";
import type { ThinkSession, ThinkRecommendation, ThinkRound } from "../think/types.js";

function renderRecommendation(rec: ThinkRecommendation): void {
  logger.plain("");
  logger.plain(pc.dim("━".repeat(55)));
  logger.plain(`${pc.bold("Recommendation:")} ${rec.choice}`);
  logger.plain(`${pc.bold("Confidence:")} ${rec.confidence.toFixed(2)}`);
  logger.plain(`${pc.bold("Reasoning:")}`);
  logger.plain(`  ${rec.reasoning}`);
  logger.plain(`${pc.bold("Tradeoffs:")}`);
  for (const pro of rec.tradeoffs.pros) {
    logger.plain(`  ${pc.green(ICONS.success)} ${pro}`);
  }
  for (const con of rec.tradeoffs.cons) {
    logger.plain(`  ${pc.red(ICONS.error)} ${con}`);
  }
  logger.plain(pc.dim("━".repeat(55)));
}

function renderRound(round: ThinkRound): void {
  logger.plain("");
  logger.plain(pc.dim("━".repeat(55)));
  logger.plain(pc.bold("Tech Lead perspective:"));
  logger.plain(round.techLeadPerspective);
  logger.plain("");
  logger.plain(pc.bold("RFC Author perspective:"));
  logger.plain(round.rfcAuthorPerspective);
  renderRecommendation(round.recommendation);
}

async function runHistory(args: string[]): Promise<void> {
  const sessionId = args.includes("--session")
    ? args[args.indexOf("--session") + 1]
    : null;

  try {
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");
    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (!embedder) {
      logger.plain("No think history available.");
      return;
    }
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const globalMgr = new GlobalMemoryManager();
    await globalMgr.init(embedder);
    const db = globalMgr.getDb();
    if (!db) {
      logger.plain("No think history available.");
      return;
    }
    const { ThinkHistoryStore } = await import("../think/history.js");
    const store = new ThinkHistoryStore();
    await store.init(db);

    if (sessionId) {
      const entry = await store.getBySessionId(sessionId);
      if (!entry) {
        logger.error(`No think session found with ID: ${sessionId}`);
        return;
      }
      logger.plain(pc.bold(`Think session: ${entry.sessionId}`));
      logger.plain(`  Question: "${entry.question}"`);
      logger.plain(`  Recommendation: ${entry.recommendation}`);
      logger.plain(`  Confidence: ${entry.confidence.toFixed(2)}`);
      logger.plain(`  Follow-ups: ${entry.followUpCount}`);
      logger.plain(`  Saved to journal: ${entry.savedToJournal ? "yes" : "no"}`);
      logger.plain(
        `  Date: ${new Date(entry.createdAt).toISOString().slice(0, 10)}`,
      );
      return;
    }

    const entries = await store.getAll();
    if (entries.length === 0) {
      logger.plain("No think sessions recorded yet.");
      return;
    }

    logger.plain(pc.bold("Think History"));
    logger.plain(pc.dim("━".repeat(55)));
    for (const e of entries) {
      const date = new Date(e.createdAt).toISOString().slice(0, 10);
      const saved = e.savedToJournal
        ? pc.green("✓ saved")
        : pc.dim("not saved");
      logger.plain(`${pc.dim(date)} ${pc.bold(e.recommendation)} ${saved}`);
      logger.plain(
        `  "${e.question}" (confidence ${e.confidence.toFixed(2)}, ${e.followUpCount} follow-ups)`,
      );
      logger.plain(`  ID: ${e.sessionId}`);
      logger.plain("");
    }
  } catch (err) {
    logger.error(`Failed to load think history: ${err}`);
  }
}

export async function runThinkCommand(args: string[]): Promise<void> {
  // Help
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    logger.plain(
      [
        pc.bold("openpawl think") +
          " — Rubber duck mode: structured thinking with agent perspectives",
        "",
        "Usage:",
        '  openpawl think "your question"               Interactive think session',
        '  openpawl think "question" --save              Auto-save to journal',
        '  openpawl think "question" --no-stream         Show results at end (no streaming)',
        '  openpawl think "question" --async             Run in background (async mode)',
        '  openpawl think "question" --async --no-save   Async without auto-saving to journal',
        "",
        "  openpawl think jobs                           List async think jobs",
        "  openpawl think jobs --pending                 Show only pending jobs",
        "  openpawl think jobs --complete                Show only completed jobs",
        "  openpawl think status [jobId]                 Show async job status",
        "  openpawl think results [jobId]                Show async job results",
        "  openpawl think cancel <jobId>                 Cancel a running async job",
        "  openpawl think clear                          Remove finished async jobs",
        "  openpawl think history                        List past think sessions",
        "  openpawl think history --session <id>         Show specific session",
      ].join("\n"),
    );
    return;
  }

  // Async subcommands
  if (args[0] === "jobs") {
    await runAsyncJobs(args.slice(1));
    return;
  }
  if (args[0] === "status") {
    await runAsyncStatus(args[1]);
    return;
  }
  if (args[0] === "results") {
    await runAsyncResults(args[1]);
    return;
  }
  if (args[0] === "cancel") {
    await runAsyncCancel(args[1]);
    return;
  }
  if (args[0] === "clear") {
    await runAsyncClear();
    return;
  }

  // History subcommand
  if (args[0] === "history") {
    await runHistory(args.slice(1));
    return;
  }

  // Parse flags
  const autoSave = args.includes("--save");
  const noStream = args.includes("--no-stream");
  const isAsync = args.includes("--async");
  const noSave = args.includes("--no-save");
  const question = args
    .filter((a) => a !== "--save" && a !== "--no-stream" && a !== "--async" && a !== "--no-save")
    .join(" ")
    .trim();

  if (!question) {
    logger.error("Please provide a question to think about.");
    return;
  }

  // Async mode: launch background job and return
  if (isAsync) {
    const { launchAsyncThink } = await import("../think/background-executor.js");
    const asyncAutoSave = !noSave;
    const result = await launchAsyncThink(question, { autoSave: asyncAutoSave });
    if (!result.ok) {
      logger.error(result.error ?? "Failed to launch async think job.");
      return;
    }
    logger.plain("");
    logger.plain(pc.bold(pc.yellow("Async think submitted")));
    logger.plain(pc.dim("━".repeat(55)));
    logger.plain(`Job ID: ${pc.cyan(result.job!.id)}`);
    logger.plain(`Question: "${question}"`);
    logger.plain(`Auto-save: ${asyncAutoSave ? "yes" : "no"}`);
    logger.plain("");
    logger.plain(pc.dim(`Check status:  openpawl think status ${result.job!.id}`));
    logger.plain(pc.dim(`View results:  openpawl think results ${result.job!.id}`));
    logger.plain(pc.dim(`List all jobs: openpawl think jobs`));
    return;
  }

  // Header
  logger.plain("");
  logger.plain(pc.bold(pc.yellow("🦆 Rubber Duck Mode")));
  logger.plain(pc.dim("━".repeat(55)));
  logger.plain(`Thinking about: "${question}"`);

  // Context loading indicator
  logger.plain(pc.dim("Checking past decisions..."));

  const { createThinkSession, addFollowUp, saveToJournal, recordToHistory } =
    await import("../think/session.js");

  // Streaming callbacks
  let currentStage = "";
  const streamingOnChunk = noStream
    ? undefined
    : (
        stage: "tech_lead" | "rfc_author" | "coordinator",
        content: string,
      ) => {
        if (stage !== currentStage) {
          currentStage = stage;
          if (stage === "tech_lead") {
            logger.plain("");
            logger.plain(pc.dim("━".repeat(55)));
            logger.plain(pc.bold("Tech Lead perspective:"));
          } else if (stage === "rfc_author") {
            logger.plain("");
            logger.plain("");
            logger.plain(pc.bold("RFC Author perspective:"));
          }
          // Don't print header for coordinator — recommendation rendered separately
          if (stage === "coordinator") return;
        }
        if (stage !== "coordinator") {
          process.stdout.write(content);
        }
      };

  let session: ThinkSession;
  try {
    session = await createThinkSession(question, {
      onChunk: streamingOnChunk,
    });
  } catch (err) {
    logger.error(`Think session failed: ${err}`);
    return;
  }

  // Show context info
  if (session.context.relevantDecisions.length > 0) {
    logger.plain(
      pc.dim(
        `\n→ ${session.context.relevantDecisions.length} relevant decision(s) found`,
      ),
    );
  }

  // Render result
  if (noStream && session.rounds[0]) {
    renderRound(session.rounds[0]);
  } else if (session.recommendation) {
    renderRecommendation(session.recommendation);
  }

  // Auto-save mode: save and exit
  if (autoSave) {
    if (
      session.recommendation &&
      session.recommendation.choice !== "Inconclusive"
    ) {
      session = await saveToJournal(session);
      logger.plain(
        pc.green(`\n✓ Decision saved: ${session.recommendation!.choice}`),
      );
    }
    await recordToHistory(session);
    return;
  }

  // Interactive loop
  let followUpCount = 0;
  const maxFollowUps = 3;

  while (true) {
    const options: Array<{ value: string; label: string }> = [
      { value: "save", label: "Save to decision journal" },
    ];
    if (followUpCount < maxFollowUps) {
      options.push({ value: "followup", label: "Ask a follow-up question" });
    }
    options.push(
      { value: "sprint", label: "Start a sprint based on this decision" },
      { value: "discard", label: "Discard" },
    );

    const action = await select({
      message: "What would you like to do?",
      options,
    });

    if (isCancel(action)) {
      await recordToHistory(session);
      return;
    }

    if (action === "save") {
      if (
        session.recommendation &&
        session.recommendation.choice !== "Inconclusive"
      ) {
        session = await saveToJournal(session);
        logger.plain(
          pc.green(`✓ Decision saved: ${session.recommendation!.choice}`),
        );
      } else {
        logger.plain(pc.yellow("Cannot save inconclusive recommendation."));
      }
      await recordToHistory(session);
      return;
    }

    if (action === "followup") {
      const followUp = await text({
        message: "Follow-up question:",
        placeholder: "What about...",
      });

      if (isCancel(followUp) || !followUp) continue;

      currentStage = "";
      try {
        session = await addFollowUp(session, String(followUp), {
          onChunk: streamingOnChunk,
        });
        followUpCount++;
        const lastRound = session.rounds[session.rounds.length - 1];
        if (noStream && lastRound) {
          renderRound(lastRound);
        } else if (session.recommendation) {
          renderRecommendation(session.recommendation);
        }
      } catch (err) {
        logger.error(`Follow-up failed: ${err}`);
      }
      continue;
    }

    if (action === "sprint") {
      // Save first
      if (
        session.recommendation &&
        session.recommendation.choice !== "Inconclusive"
      ) {
        session = await saveToJournal(session);
        logger.plain(
          pc.green(`✓ Decision saved: ${session.recommendation!.choice}`),
        );
      }
      await recordToHistory(session);

      // Launch work with pre-populated goal
      const goal = `Implement: ${session.recommendation?.choice ?? session.question}`;
      logger.plain(`\nStarting sprint with goal: "${goal}"`);
      logger.plain(pc.dim("You can modify the goal in the setup wizard.\n"));

      const { spawn } = await import("node:child_process");
      spawn("npx", ["openpawl", "work"], {
        stdio: "inherit",
        env: { ...process.env, OPENPAWL_SUGGESTED_GOAL: goal },
      });
      return;
    }

    if (action === "discard") {
      await recordToHistory(session);
      logger.plain(pc.dim("Think session discarded."));
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Async think helpers
// ---------------------------------------------------------------------------

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function statusBadge(status: string): string {
  switch (status) {
    case "queued": return pc.dim("queued");
    case "running": return pc.yellow("running");
    case "completed": return pc.green("completed");
    case "failed": return pc.red("failed");
    case "cancelled": return pc.dim("cancelled");
    default: return status;
  }
}

async function runAsyncJobs(args: string[]): Promise<void> {
  const { AsyncThinkJobStore } = await import("../think/job-store.js");
  const store = new AsyncThinkJobStore();
  let jobs = store.list();

  if (args.includes("--pending")) {
    jobs = jobs.filter((j) => j.status === "queued" || j.status === "running");
  } else if (args.includes("--complete")) {
    jobs = jobs.filter((j) => j.status === "completed");
  }

  if (jobs.length === 0) {
    logger.plain("No async think jobs found.");
    return;
  }

  logger.plain(pc.bold("Async Think Jobs"));
  logger.plain(pc.dim("━".repeat(55)));
  const now = Date.now();
  for (const job of jobs) {
    const q = job.question.length > 40 ? job.question.slice(0, 37) + "..." : job.question;
    const age = formatAge(now - job.createdAt);
    logger.plain(`${pc.cyan(job.id)} ${statusBadge(job.status)} ${pc.dim(age)}`);
    logger.plain(`  "${q}"`);
    if (job.status === "completed" && job.result?.recommendation) {
      logger.plain(`  ${pc.green("→")} ${job.result.recommendation.choice}`);
    }
    if (job.status === "failed" && job.error) {
      logger.plain(`  ${pc.red("→")} ${job.error}`);
    }
    logger.plain("");
  }
}

async function runAsyncStatus(jobId?: string): Promise<void> {
  const { AsyncThinkJobStore } = await import("../think/job-store.js");
  const store = new AsyncThinkJobStore();

  if (!jobId) {
    // Show pending jobs
    const pending = store.list().filter((j) => j.status === "queued" || j.status === "running");
    if (pending.length === 0) {
      logger.plain("No pending async think jobs.");
      return;
    }
    for (const job of pending) {
      const age = formatAge(Date.now() - job.createdAt);
      logger.plain(`${pc.cyan(job.id)} ${statusBadge(job.status)} ${pc.dim(age)} — "${job.question}"`);
    }
    return;
  }

  const job = store.get(jobId);
  if (!job) {
    logger.error(`Job not found: ${jobId}`);
    return;
  }

  logger.plain(pc.bold(`Async Think Job: ${job.id}`));
  logger.plain(pc.dim("━".repeat(55)));
  logger.plain(`Status:    ${statusBadge(job.status)}`);
  logger.plain(`Question:  "${job.question}"`);
  logger.plain(`Auto-save: ${job.autoSave ? "yes" : "no"}`);
  logger.plain(`Created:   ${new Date(job.createdAt).toISOString()}`);
  if (job.startedAt) logger.plain(`Started:   ${new Date(job.startedAt).toISOString()}`);
  if (job.completedAt) {
    logger.plain(`Completed: ${new Date(job.completedAt).toISOString()}`);
    logger.plain(`Duration:  ${formatAge(job.completedAt - (job.startedAt ?? job.createdAt))}`);
  }
  if (job.error) logger.plain(`Error:     ${pc.red(job.error)}`);
  if (job.notificationSent) logger.plain(`Notified:  yes`);
  if (job.briefedAt) logger.plain(`Briefed:   ${new Date(job.briefedAt).toISOString()}`);
  if (job.result?.recommendation) {
    logger.plain("");
    renderRecommendation(job.result.recommendation);
  }
}

async function runAsyncResults(jobId?: string): Promise<void> {
  const { AsyncThinkJobStore } = await import("../think/job-store.js");
  const store = new AsyncThinkJobStore();

  if (!jobId) {
    // Show most recent completed job
    const completed = store.getCompleted();
    if (completed.length === 0) {
      logger.plain("No completed async think jobs.");
      return;
    }
    jobId = completed[0].id;
  }

  const job = store.get(jobId);
  if (!job) {
    logger.error(`Job not found: ${jobId}`);
    return;
  }
  if (job.status !== "completed" || !job.result) {
    logger.plain(`Job ${pc.cyan(job.id)} is ${statusBadge(job.status)} — no results yet.`);
    return;
  }

  logger.plain("");
  logger.plain(pc.bold(pc.yellow("Async Think Results")));
  logger.plain(pc.dim("━".repeat(55)));
  logger.plain(`Job: ${pc.cyan(job.id)}`);
  logger.plain(`Question: "${job.question}"`);

  for (const round of job.result.rounds) {
    renderRound(round);
  }

  if (job.result.savedToJournal) {
    logger.plain(pc.green("\n✓ Decision saved to journal"));
  }
}

async function runAsyncCancel(jobId?: string): Promise<void> {
  if (!jobId) {
    logger.error("Usage: openpawl think cancel <jobId>");
    return;
  }

  const { AsyncThinkJobStore } = await import("../think/job-store.js");
  const store = new AsyncThinkJobStore();
  const job = store.get(jobId);

  if (!job) {
    logger.error(`Job not found: ${jobId}`);
    return;
  }

  if (job.status !== "running" && job.status !== "queued") {
    logger.plain(`Job ${pc.cyan(job.id)} is already ${statusBadge(job.status)}.`);
    return;
  }

  if (job.pid !== null) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process already gone
    }
  }

  job.status = "cancelled";
  job.completedAt = Date.now();
  store.save(job);
  logger.plain(`Cancelled job ${pc.cyan(job.id)}.`);
}

async function runAsyncClear(): Promise<void> {
  const { AsyncThinkJobStore } = await import("../think/job-store.js");
  const store = new AsyncThinkJobStore();
  const count = store.clearFinished();
  logger.plain(`Cleared ${count} finished job${count !== 1 ? "s" : ""}.`);
}
