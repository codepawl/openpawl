/**
 * /research command — autonomous optimization loop.
 *
 * Usage:
 *   /research <description>     Start a new research loop (interactive config)
 *   /research status            Show current research status
 *   /research pause             Pause the running loop
 *   /research resume            Resume a paused loop
 *   /research stop              Stop the loop and show results
 *   /research report            Show final report
 */
import type { SlashCommand, CommandContext } from "../../tui/index.js";
import { defaultTheme } from "../../tui/themes/default.js";
import { ICONS } from "../../tui/constants/icons.js";
import type { ResearchRunner } from "../../research/runner.js";
import type { ResearchConfig } from "../../research/types.js";

let activeRunner: ResearchRunner | null = null;

export function createResearchCommand(): SlashCommand {
  return {
    name: "research",
    description: "Autonomous optimization loop",
    args: "<description> | status | pause | resume | stop | report",
    async execute(args: string, ctx: CommandContext) {
      const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase();

      switch (subcommand) {
        case "status":
          return showStatus(ctx);
        case "pause":
          return pauseResearch(ctx);
        case "resume":
          return resumeResearch(ctx);
        case "stop":
          return stopResearch(ctx);
        case "report":
          return showReport(ctx);
        default:
          return startResearch(args.trim(), ctx);
      }
    },
  };
}

async function startResearch(description: string, ctx: CommandContext): Promise<void> {
  if (!description) {
    ctx.addMessage("system", "Usage: /research <what to optimize>");
    return;
  }

  if (activeRunner) {
    ctx.addMessage("system", "A research loop is already running. Use /research stop first.");
    return;
  }

  // Default config — user can customize via /research --config later
  const config: ResearchConfig = {
    name: description.slice(0, 40),
    metric: {
      command: "bun run test",
      extract: "\\d+ tests?",
      direction: "maximize",
      baseline: null,
    },
    change: {
      scope: ["src/"],
      strategy: "iterative",
    },
    assess: {
      tests: "bun run test",
      typecheck: "bun run typecheck",
    },
    constraints: {
      maxIterations: 50,
      maxRegressionsBeforeStop: 5,
      requireTestPass: true,
      timeoutMs: 4 * 60 * 60 * 1000, // 4 hours
    },
  };

  ctx.addMessage("system", [
    defaultTheme.info(`Starting research: ${description}`),
    "",
    `  Metric: ${config.metric.command}`,
    `  Scope: ${config.change.scope.join(", ")}`,
    `  Max iterations: ${config.constraints.maxIterations}`,
    `  Branch: research/${config.name.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()}`,
    "",
    defaultTheme.dim("Use /research status, /research pause, /research stop"),
  ].join("\n"));
  ctx.requestRender();

  try {
    const { ResearchRunner } = await import("../../research/runner.js");

    activeRunner = new ResearchRunner(config, (event) => {
      switch (event.type) {
        case "started":
          ctx.addMessage("system", defaultTheme.success(`Baseline: ${event.baseline}`));
          ctx.requestRender();
          break;
        case "iteration_end": {
          const it = event.iteration;
          const icon = it.kept ? defaultTheme.success(ICONS.success) : defaultTheme.error(ICONS.error);
          const delta = it.delta > 0 ? `+${it.delta}` : String(it.delta);
          ctx.addMessage("system",
            `${icon} #${it.index}: ${it.description} (${it.scoreBefore}${ICONS.arrow}${it.scoreAfter}, ${delta})`,
          );
          ctx.requestRender();
          break;
        }
        case "completed":
        case "stopped": {
          const r = event.result;
          ctx.addMessage("system", [
            defaultTheme.info("── Research Complete ──"),
            `Baseline: ${r.baseline} ${ICONS.arrow} Final: ${r.finalScore}`,
            `Iterations: ${r.totalIterations} (${r.keptChanges} kept, ${r.revertedChanges} reverted)`,
            `Duration: ${Math.round(r.durationMs / 60_000)}m`,
            "",
            defaultTheme.dim("Use /research report for full details"),
          ].join("\n"));
          ctx.requestRender();
          activeRunner = null;
          break;
        }
        case "error":
          ctx.addMessage("error", `Research error: ${event.message}`);
          ctx.requestRender();
          break;
      }
    });

    // Run in background
    void activeRunner.run().catch((err) => {
      ctx.addMessage("error", `Research crashed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.requestRender();
      activeRunner = null;
    });
  } catch (err) {
    ctx.addMessage("error", `Failed to start research: ${err instanceof Error ? err.message : String(err)}`);
    ctx.requestRender();
  }
}

function showStatus(ctx: CommandContext): void {
  if (!activeRunner) {
    ctx.addMessage("system", "No active research loop. Start one with /research <description>");
    return;
  }

  const state = activeRunner.getState();
  const elapsed = Math.round((Date.now() - state.startedAt) / 60_000);
  const improvement = state.bestScore - state.baseline;

  ctx.addMessage("system", [
    defaultTheme.info(`── Research: ${state.config.name} ──`),
    `Status: ${state.status}`,
    `Branch: ${state.branch}`,
    `Baseline: ${state.baseline} → Best: ${state.bestScore} (${improvement > 0 ? "+" : ""}${improvement})`,
    `Iteration: ${state.currentIteration}/${state.config.constraints.maxIterations}`,
    `Consecutive regressions: ${state.consecutiveRegressions}/${state.config.constraints.maxRegressionsBeforeStop}`,
    `Elapsed: ${elapsed}m`,
  ].join("\n"));
}

function pauseResearch(ctx: CommandContext): void {
  if (!activeRunner) {
    ctx.addMessage("system", "No active research loop.");
    return;
  }
  activeRunner.pause();
  ctx.addMessage("system", defaultTheme.warning("Research paused. Use /research resume to continue."));
}

function resumeResearch(ctx: CommandContext): void {
  if (!activeRunner) {
    ctx.addMessage("system", "No active research loop.");
    return;
  }
  activeRunner.resume();
  ctx.addMessage("system", defaultTheme.success("Research resumed."));
}

function stopResearch(ctx: CommandContext): void {
  if (!activeRunner) {
    ctx.addMessage("system", "No active research loop.");
    return;
  }
  activeRunner.stop();
  // The event handler will display results and clear activeRunner
}

function showReport(ctx: CommandContext): void {
  if (!activeRunner) {
    ctx.addMessage("system", "No active research loop. Results are shown when research completes.");
    return;
  }
  const report = activeRunner.getReport();
  ctx.addMessage("system", report);
}
