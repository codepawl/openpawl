/**
 * CLI command: teamclaw think
 * Lightweight structured thinking mode — rubber duck debugging.
 */

import pc from "picocolors";
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
    logger.plain(`  ${pc.green("✓")} ${pro}`);
  }
  for (const con of rec.tradeoffs.cons) {
    logger.plain(`  ${pc.red("✗")} ${con}`);
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
        pc.bold("teamclaw think") +
          " — Rubber duck mode: structured thinking with agent perspectives",
        "",
        "Usage:",
        '  teamclaw think "your question"               Interactive think session',
        '  teamclaw think "question" --save              Auto-save to journal',
        '  teamclaw think "question" --no-stream         Show results at end (no streaming)',
        "  teamclaw think history                        List past think sessions",
        "  teamclaw think history --session <id>         Show specific session",
      ].join("\n"),
    );
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
  const question = args
    .filter((a) => a !== "--save" && a !== "--no-stream")
    .join(" ")
    .trim();

  if (!question) {
    logger.error("Please provide a question to think about.");
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
      spawn("npx", ["teamclaw", "work"], {
        stdio: "inherit",
        env: { ...process.env, TEAMCLAW_SUGGESTED_GOAL: goal },
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
