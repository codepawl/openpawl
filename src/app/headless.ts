/**
 * Headless mode — runs the agent pipeline without TUI rendering.
 * Supports three modes:
 *   --mode sprint  (default) — planner → coders → reviewer via SprintRunner
 *   --mode chat    — single agent via PromptRouter (same as interactive chat)
 *   --mode auto    — sprint for multi-step goals, chat for simple ones
 *
 * Agent tool calls write to a dedicated project directory (not cwd):
 *   ~/personal/openpawl-test-projects/<goal-slug>-<timestamp>/
 *   Override with --workdir <path>
 *
 * Usage: openpawl run --headless --goal "..." [--runs N] [--mode sprint|chat|auto] [--workdir path]
 */

import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";
import { formatDuration } from "../utils/formatters.js";
import { SprintEvent, ToolEvent } from "../router/event-types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { createSessionManager } from "../session/index.js";
import { PromptRouter, AgentRegistry } from "../router/index.js";
import { createLLMAgentRunner } from "../router/llm-agent-runner.js";
import { createSprintRunner } from "../sprint/create-sprint-runner.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolExecutor } from "../tools/executor.js";
import { PermissionResolver } from "../tools/permissions.js";
import { registerBuiltInTools } from "../tools/built-in/index.js";
import {
  profileStart,
  isProfilingEnabled,
  generateReport as generateProfileReport,
} from "../telemetry/profiler.js";

type RunMode = "sprint" | "chat" | "auto";

interface HeadlessOptions {
  goal: string;
  runs: number;
  mode: RunMode;
  workdir: string | null;
}

function parseArgs(args: string[]): HeadlessOptions {
  let goal = "";
  let runs = 1;
  let mode: RunMode = "auto";
  let workdir: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--goal" && args[i + 1]) {
      goal = args[++i]!;
    } else if (arg === "--runs" && args[i + 1]) {
      runs = parseInt(args[++i]!, 10) || 1;
    } else if (arg === "--mode" && args[i + 1]) {
      const m = args[++i]!;
      if (m === "sprint" || m === "chat" || m === "auto") mode = m;
    } else if (arg === "--workdir" && args[i + 1]) {
      workdir = args[++i]!;
    } else if (arg === "--headless") {
      // already handled by caller
    } else if (!arg.startsWith("-") && !goal) {
      goal = arg;
    }
  }

  if (!goal) {
    console.error("Usage: openpawl run --headless --goal \"<prompt>\" [--runs N] [--mode sprint|chat|auto] [--workdir path]");
    process.exit(1);
  }

  return { goal, runs, mode, workdir };
}


/** Convert goal text to a filesystem-safe slug. */
function goalSlug(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Heuristic: does the goal look like a multi-step project? */
function isComplexGoal(goal: string): boolean {
  const lower = goal.toLowerCase();
  const hasMultipleFeatures = (lower.match(/\b(and|with|plus|also|including)\b/g) ?? []).length >= 2;
  const isBuildGoal = /\b(build|create|implement|develop|make|set up)\b/.test(lower);
  const isLong = goal.length > 80;
  return (hasMultipleFeatures && isBuildGoal) || (isLong && isBuildGoal);
}

export async function runHeadless(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const finishTotal = profileStart("total_pipeline", "headless");

  // Resolve mode
  let effectiveMode = opts.mode;
  if (effectiveMode === "auto") {
    effectiveMode = isComplexGoal(opts.goal) ? "sprint" : "chat";
  }

  // Resolve working directory for agent tool calls
  const testProjectsBase = join(homedir(), "personal", "openpawl-test-projects");
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
  const projectDir = opts.workdir ?? join(testProjectsBase, `${goalSlug(opts.goal)}-${dateStr}-${timeStr}`);
  mkdirSync(projectDir, { recursive: true });

  const originalCwd = process.cwd();

  console.log(pc.bold("openpawl headless mode"));
  console.log(pc.dim(`Goal: ${opts.goal}`));
  console.log(pc.dim(`Mode: ${effectiveMode} | Runs: ${opts.runs}`));
  console.log(pc.dim(`Project dir: ${projectDir}`));
  console.log("");

  // Initialize session manager
  const sessionMgr = createSessionManager();
  await sessionMgr.initialize();

  // Initialize tool registry + executor (shared across modes)
  const toolReg = new ToolRegistry();
  registerBuiltInTools(toolReg);
  const toolExec = new ToolExecutor(toolReg, new PermissionResolver());

  // Auto-approve tool confirmations in headless mode
  toolExec.on(ToolEvent.ConfirmationNeeded, ({ approve }: { approve: (always?: boolean) => void }) => {
    approve();
  });

  for (let run = 0; run < opts.runs; run++) {
    if (opts.runs > 1) {
      console.log(pc.bold(`\n── Run ${run + 1}/${opts.runs} ──`));
    }

    // Switch to the project directory for agent tool calls
    process.chdir(projectDir);

    const runStart = Date.now();

    if (effectiveMode === "sprint") {
      await runSprint(opts.goal, toolReg, toolExec);
    } else {
      await runChat(opts.goal, sessionMgr, toolReg, toolExec);
    }

    const runDuration = Date.now() - runStart;
    console.log("");
    console.log(pc.dim("─".repeat(60)));
    console.log(`Total: ${pc.bold(formatDuration(runDuration))}`);
  }

  // Restore original cwd
  process.chdir(originalCwd);

  finishTotal();

  // Write profiler report
  if (isProfilingEnabled()) {
    const profileDir = join(homedir(), ".openpawl");
    mkdirSync(profileDir, { recursive: true });
    const reportPath = join(profileDir, "profile-report.md");
    writeFileSync(reportPath, generateProfileReport());
    console.log(`\n${pc.dim(`Profile report: ${reportPath}`)}`);
  }

  console.log(`\n${pc.dim(`Project files: ${projectDir}`)}`);

  await sessionMgr.shutdown();
}

// ── Sprint mode ───────────────────────────────────────────────────────

async function runSprint(
  goal: string,
  toolReg: ToolRegistry,
  toolExec: ToolExecutor,
): Promise<void> {
  const agents = new AgentRegistry();
  const runner = createSprintRunner({ agents, toolRegistry: toolReg, toolExecutor: toolExec });

  let taskTokens = 0;
  let taskStart = 0;

  runner.on(SprintEvent.Planning, () => {
    process.stdout.write(`  ${pc.cyan("[planner]")} planning tasks...`);
    taskStart = Date.now();
    taskTokens = 0;
  });

  runner.on(SprintEvent.Plan, ({ tasks }) => {
    const elapsed = Date.now() - taskStart;
    process.stdout.write(` ${pc.dim("\u2192")} ${pc.green(`${tasks.length} tasks`)} (${formatDuration(elapsed)})\n`);
    console.log("");
    for (let i = 0; i < tasks.length; i++) {
      console.log(`  ${pc.dim(`${i + 1}.`)} ${tasks[i]!.description.slice(0, 80)}`);
    }
    console.log("");
  });

  runner.on(SprintEvent.RoundStart, ({ round, tasks }) => {
    if (tasks.length > 1) {
      console.log(`  ${pc.bold(`[round ${round} \u2014 ${tasks.length} tasks in parallel]`)}`);
    }
  });

  runner.on(SprintEvent.RoundComplete, ({ round, duration }) => {
    console.log(`  ${pc.dim(`[round ${round} complete: ${formatDuration(duration)}]`)}`);
    console.log("");
  });

  runner.on(SprintEvent.TaskStart, ({ task, agentName }) => {
    taskTokens = 0;
    taskStart = Date.now();
    process.stdout.write(`  ${pc.cyan(`[${agentName}]`)} ${task.description.slice(0, 60)}`);
  });

  runner.on(SprintEvent.AgentToken, () => {
    taskTokens++;
  });

  runner.on(SprintEvent.AgentTool, ({ toolName, status }) => {
    if (status === "running") {
      process.stdout.write(`\n    ${pc.dim(`tool: ${toolName}`)}`);
    } else if (status === "completed") {
      process.stdout.write(pc.dim(` ${ICONS.success}`));
    } else if (status === "failed") {
      process.stdout.write(pc.red(` ${ICONS.error}`));
    }
  });

  runner.on(SprintEvent.TaskComplete, ({ task }) => {
    const elapsed = Date.now() - taskStart;
    const status = task.status === "completed" ? pc.green("done")
      : task.status === "failed" ? pc.red("failed")
      : pc.yellow("incomplete");
    process.stdout.write(` ${pc.dim(ICONS.arrow)} ${status} (${formatDuration(elapsed)}, ${taskTokens} tokens)\n`);
  });

  runner.on(SprintEvent.Warning, ({ warning }) => {
    console.log(`  ${pc.yellow(ICONS.warning)} ${warning}`);
  });

  runner.on(SprintEvent.Error, ({ error }) => {
    console.error(`  ${pc.red(ICONS.error)} ${error.message}`);
  });

  const result = await runner.run(goal);

  console.log("");
  console.log(pc.dim("─".repeat(60)));
  console.log(
    `Tasks: ${result.completedTasks}/${result.tasks.length} completed | ` +
    `Failed: ${result.failedTasks} | ` +
    `Duration: ${formatDuration(result.duration)}`,
  );
}

// ── Chat mode (single agent via PromptRouter) ─────────────────────────

async function runChat(
  goal: string,
  sessionMgr: ReturnType<typeof createSessionManager>,
  toolReg: ToolRegistry,
  toolExec: ToolExecutor,
): Promise<void> {
  const sessionResult = await sessionMgr.create(process.cwd());
  if (sessionResult.isErr()) {
    console.error(`Failed to create session: ${sessionResult.error.type}`);
    process.exit(1);
  }
  const session = sessionResult.value;

  let currentAgent = "";
  let tokenCount = 0;
  const agentStartTimes = new Map<string, number>();

  const agentRunner = createLLMAgentRunner({
    onToken: (agentId, _token) => {
      if (agentId !== currentAgent) {
        if (currentAgent) {
          const elapsed = Date.now() - (agentStartTimes.get(currentAgent) ?? Date.now());
          process.stdout.write(
            ` ${pc.dim("\u2192")} ${pc.green("done")} (${formatDuration(elapsed)}, ${tokenCount} tokens)\n`,
          );
        }
        currentAgent = agentId;
        tokenCount = 0;
        agentStartTimes.set(agentId, Date.now());
        process.stdout.write(`  ${pc.cyan(`[${agentId}]`)} started`);
      }
      tokenCount++;
    },
    onToolCall: (_agentId, toolName, status) => {
      if (status === "running") {
        process.stdout.write(`\n    ${pc.dim(`tool: ${toolName}`)}`);
      } else if (status === "completed") {
        process.stdout.write(pc.dim(` ${ICONS.success}`));
      } else if (status === "failed") {
        process.stdout.write(pc.red(` ${ICONS.error}`));
      }
    },
    getToolSchemas: (toolNames) => toolReg.exportForLLM(toolNames),
    getNativeTools: (toolNames) => toolReg.exportForAPI(toolNames),
    executeTool: async (toolName, args) => {
      const result = await toolExec.execute(toolName, args, {
        sessionId: session.id,
        agentId: "agent",
        workingDirectory: process.cwd(),
      });
      if (result.isOk()) {
        return result.value.fullOutput || JSON.stringify(result.value.data) || result.value.summary;
      }
      const cause = "cause" in result.error ? `: ${result.error.cause}` : "";
      throw new Error(`${result.error.type}${cause}`);
    },
  });

  const router = new PromptRouter(
    { defaultAgent: "assistant" },
    sessionMgr,
    null,
    agentRunner,
  );

  const result = await router.route(session.id, goal);

  // Finish last agent line
  if (currentAgent) {
    const elapsed = Date.now() - (agentStartTimes.get(currentAgent) ?? Date.now());
    process.stdout.write(
      ` ${pc.dim("\u2192")} ${pc.green("done")} (${formatDuration(elapsed)}, ${tokenCount} tokens)\n`,
    );
  }

  if (result.isErr()) {
    console.error(`\n${pc.red("Error:")} ${result.error.type}`);
    if ("message" in result.error) {
      console.error(`  ${(result.error as { message: string }).message}`);
    }
    process.exit(1);
  }

  const dispatch = result.value;
  console.log("");
  for (const agentResult of dispatch.agentResults) {
    if (agentResult.error) {
      console.log(pc.dim("\u2500".repeat(60)));
      console.log(`${pc.bold(`[${agentResult.agentId}]`)} ${pc.red("error")}`);
      console.log(pc.red(agentResult.error));
    } else if (agentResult.response) {
      console.log(pc.dim("\u2500".repeat(60)));
      console.log(pc.bold(`[${agentResult.agentId}]`));
      console.log(agentResult.response);
    }
  }

  const totalIn = dispatch.totalInputTokens;
  const totalOut = dispatch.totalOutputTokens;
  const cost = (totalIn * 3 + totalOut * 15) / 1_000_000;
  console.log(pc.dim(`Tokens: ${totalIn}in/${totalOut}out | Cost: $${cost.toFixed(4)}`));

  await sessionMgr.delete(session.id);
}
