/**
 * Work Runner - Team orchestration sessions with lesson learning.
 */

import { createTeamOrchestration } from "./core/simulation.js";
import { buildTeamFromRoster, buildTeamFromTemplate } from "./core/team-templates.js";
import { getWorkerUrlsForTeam, setSessionConfig, clearSessionConfig } from "./core/config.js";
import { loadTeamConfig } from "./core/team-config.js";
import { VectorMemory } from "./core/knowledge-base.js";
import { PostMortemAnalyst } from "./agents/analyst.js";
import { CONFIG } from "./core/config.js";
import { provisionOpenClaw } from "./core/provisioning.js";
import { validateStartup } from "./core/startup-validation.js";
import { appendFile } from "node:fs/promises";
import { clearSessionWarnings, getSessionWarnings } from "./core/session-warnings.js";
import { ensureChromaDB } from "./core/ensure-chromadb.js";
import { logger } from "./core/logger.js";
import { ensureWorkspaceDir } from "./core/workspace-fs.js";

function log(level: "info" | "warn" | "error", msg: string): void {
  const levelUp = level.toUpperCase() as "INFO" | "WARN" | "ERROR";
  if (level === "info") logger.info(msg);
  else if (level === "warn") logger.warn(msg);
  else logger.error(msg);
  appendFile("work_history.log", logger.plainLine(levelUp, msg) + "\n").catch(() => {});
}

function printRunBanner(runId: number, lessonsCount: number, totalRuns: number): void {
  const banner = `
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║                    START WORKING! - RUN ${String(runId).padStart(2)}/${totalRuns}                      ║
║                                                                   ║
║          Prior run lessons: ${String(lessonsCount).padStart(2)}                                      ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
`;
  logger.plain(banner);
}

function printSingleRunSummary(
  goal: string,
  finalState: Record<string, unknown>,
  warnings: string[]
): void {
  const taskQueue = (finalState.task_queue ?? []) as Record<string, unknown>[];
  const cycleCount = (finalState.cycle_count as number) ?? 0;

  const lines: string[] = [
    "",
    "═".repeat(70),
    "RUN SUMMARY",
    "═".repeat(70),
    "",
    `Goal: ${goal}`,
    `Cycles: ${cycleCount}`,
    "",
    "Tasks:",
  ];

  if (taskQueue.length === 0) {
    lines.push("  (none)");
  } else {
    for (const t of taskQueue) {
      const id = (t.task_id as string) ?? "?";
      const desc = String(t.description ?? "(no description)").slice(0, 60);
      const status = (t.status as string) ?? "?";
      const assignedTo = (t.assigned_to as string) ?? "?";
      const result = t.result;
      const resultPreview =
        result != null && typeof result === "object" && "output" in result
          ? String((result as Record<string, unknown>).output ?? "").slice(0, 80)
          : result != null
            ? String(result).slice(0, 80)
            : null;
      lines.push(`  • ${id} [${status}] ${assignedTo}: ${desc}`);
      if (resultPreview) lines.push(`    Output: ${resultPreview}${resultPreview.length >= 80 ? "…" : ""}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    warnings.forEach((w) => lines.push(`  ⚠ ${w}`));
  }

  lines.push("");
  lines.push("═".repeat(70));
  logger.plain(lines.join("\n"));
}

function printWorkSummary(
  stats: {
    runs_completed: number;
    failures: number;
    longest_run_cycles: number;
    total_tasks_completed: number;
    total_lessons_learned: number;
  },
  lessons: string[]
): void {
  const oldest = lessons[0] ?? "(none)";
  const newest = lessons[lessons.length - 1] ?? "(none)";
  const banner = `
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║                      WORK SESSIONS COMPLETE                       ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝

Run Statistics:
  • Completed: ${stats.runs_completed}
  • Failures: ${stats.failures}
  • Successful: ${stats.runs_completed - stats.failures}

Performance:
  • Longest run: ${stats.longest_run_cycles} cycles
  • Total tasks completed: ${stats.total_tasks_completed}
  • Lessons learned: ${stats.total_lessons_learned}

Prior run wisdom:
  • Total lessons: ${lessons.length}
  • Oldest: "${oldest}"
  • Newest: "${newest}"

╔═══════════════════════════════════════════════════════════════════╗
║                    LESSONS ACCUMULATED                            ║
╚═══════════════════════════════════════════════════════════════════╝
`;
  logger.plain(banner);
  lessons.forEach((l, i) => logger.plain(`  ${i + 1}. ${l}`));
  logger.plain("\n" + "=".repeat(70));
  logger.plain("History saved to:");
  logger.plain("   • work_history.log");
  logger.plain("   • data/vector_store/");
  logger.plain("=".repeat(70) + "\n");
}

export async function runWork(input: string[] | { args?: string[]; goal?: string } = []): Promise<void> {
  const args = Array.isArray(input) ? input : (input.args ?? []);
  const goalOverride = Array.isArray(input) ? undefined : input.goal?.trim();
  let maxRuns = 1;
  let clearLegacy = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--runs" && args[i + 1]) {
      maxRuns = Math.max(1, parseInt(args[i + 1], 10) || 1);
      i++;
    } else if (args[i] === "--generations" && args[i + 1]) {
      maxRuns = Math.max(1, parseInt(args[i + 1], 10) || 1);
      i++;
    } else if (args[i] === "--clear-legacy") {
      clearLegacy = true;
    }
  }

  if (maxRuns > CONFIG.maxRuns) {
    maxRuns = CONFIG.maxRuns;
  }

  log("info", "Start working!");
  log("info", `   Runs: ${maxRuns}`);
  log("info", "");

  await ensureWorkspaceDir(CONFIG.workspaceDir);

  await ensureChromaDB((msg) => log("info", `   ${msg}`));

  const vectorMemory = new VectorMemory(CONFIG.chromadbPersistDir);
  await vectorMemory.init();

  if (clearLegacy) {
    log("warn", "Clearing lesson data is not implemented (delete data/vector_store manually)");
  }

  const analyst = new PostMortemAnalyst(vectorMemory);
  const workStats = {
    runs_completed: 0,
    total_lessons_learned: 0,
    longest_run_cycles: 0,
    total_tasks_completed: 0,
    failures: 0,
  };

  const defaultGoal = "Build a small 2D game with sprite assets and sound effects";

  const teamConfigForValidation = await loadTeamConfig();
  const result = await validateStartup({
    templateId: teamConfigForValidation?.template,
    maxCycles: CONFIG.maxCycles,
    maxRuns,
  });
  if (!result.ok) {
    log("error", result.message);
    process.exit(1);
  }

  for (let runId = 1; runId <= maxRuns; runId++) {
    try {
      const teamConfig = await loadTeamConfig();
      const goal = goalOverride || teamConfig?.goal?.trim() || defaultGoal;
      const priorLessons = await vectorMemory.getCumulativeLessons();
      const runWarnings: string[] = [];
      clearSessionWarnings();
      if (!vectorMemory.enabled) {
        runWarnings.push("ChromaDB unavailable. Using JSON fallback for lessons.");
      }

      if (maxRuns > 1) {
        printRunBanner(runId, priorLessons.length, maxRuns);
      } else {
        log("info", "Initializing work session...");
      }
      log("info", `   Goal: ${goal}`);

      const template = teamConfig?.template ?? "game_dev";
      const creativity =
        typeof teamConfig?.creativity === "number"
          ? teamConfig.creativity
          : CONFIG.creativity;
      setSessionConfig({
        creativity,
        gateway_url: teamConfig?.gateway_url,
        team_model: teamConfig?.team_model,
      });
      const team =
        teamConfig?.roster && teamConfig.roster.length > 0
          ? buildTeamFromRoster(teamConfig.roster)
          : buildTeamFromTemplate(template);
      const workerUrls = getWorkerUrlsForTeam(team.map((b) => b.id), {
        workers: teamConfig?.workers,
      });
      const openclawUrl =
        CONFIG.openclawWorkerUrl?.trim() || (Object.values(workerUrls)[0] as string | undefined);
      if (!openclawUrl) {
        throw new Error("❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.");
      }
      if (runId === 1) {
        let provisioned = false;
        let lastError: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const r = await provisionOpenClaw({ workerUrl: openclawUrl });
          if (r.ok) {
            provisioned = true;
            log("info", "OpenClaw provisioned");
            break;
          }
          lastError = r.error;
          log(
            "warn",
            `OpenClaw provisioning attempt ${attempt} failed: ${r.error ?? "unknown error"}`,
          );
          if (attempt < 2) await new Promise((res) => setTimeout(res, 2000));
        }
        if (!provisioned) {
          throw new Error(
            `❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.${
              lastError ? ` Details: ${lastError}` : ""
            }`,
          );
        }
      }
      const orchestration = createTeamOrchestration({ team, workerUrls });
      const finalState = await orchestration.run({
        userGoal: goal,
        ancestralLessons: priorLessons,
      });

      const botStats = (finalState as Record<string, unknown>).bot_stats as Record<
        string,
        Record<string, unknown>
      > | null;
      const totalDone = botStats
        ? Object.values(botStats).reduce((s, x) => s + ((x?.tasks_completed as number) ?? 0), 0)
        : 0;
      const totalFailed = botStats
        ? Object.values(botStats).reduce((s, x) => s + ((x?.tasks_failed as number) ?? 0), 0)
        : 0;

      workStats.runs_completed = runId;
      workStats.longest_run_cycles = Math.max(
        workStats.longest_run_cycles,
        (finalState as Record<string, unknown>).cycle_count as number
      );
      workStats.total_tasks_completed += totalDone;

      const totalTasks = totalDone + totalFailed;
      const failed = totalTasks > 0 && (totalFailed >= totalDone || totalDone === 0);

      if (failed && maxRuns > 1) {
        workStats.failures += 1;
        log("error", `Run ${runId} failed`);
        log("info", "Running post-mortem analysis...");
        const cause = `Tasks: ${totalFailed} failed, ${totalDone} completed`;
        const stateWithCause = {
          ...finalState,
          death_reason: cause,
          generation_id: runId,
        };
        const lesson = await analyst.analyzeFailure(stateWithCause);
        workStats.total_lessons_learned += 1;
        const report = analyst.generatePostMortemReport(stateWithCause, lesson);
        logger.plain(report);
        log("info", `Lesson learned. Proceeding to run ${runId + 1}`);
        log("info", "");
      } else if (failed && maxRuns === 1) {
        log(
          "warn",
          `Work session completed with failures: ${totalDone} done, ${totalFailed} failed`
        );
        break;
      } else {
        log("info", `Run ${runId} completed`);
        log("info", `   Cycles: ${(finalState as Record<string, unknown>).cycle_count}`);
        log("info", `   Tasks: ${totalDone} completed, ${totalFailed} failed`);
        if (maxRuns === 1) {
          const allWarnings = [...runWarnings, ...getSessionWarnings()];
          printSingleRunSummary(
            goal,
            finalState as Record<string, unknown>,
            allWarnings
          );
        }
        log("info", "");
        if (maxRuns === 1) break;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "SIGINT") {
        log("warn", "\nWork session interrupted by user");
      } else {
        log("error", `Fatal error in run ${runId}: ${err}`);
        logger.error(String(err));
      }
      break;
    }
  }

  clearSessionConfig();
  if (maxRuns > 1) {
    const lessons = await vectorMemory.getCumulativeLessons();
    printWorkSummary(workStats, lessons);
  } else {
    log("info", "Work session finished.");
  }
}
