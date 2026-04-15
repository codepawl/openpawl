/**
 * Headless mode — runs the agent pipeline without TUI rendering.
 * Supports four modes:
 *   --mode sprint  (default) — planner → coders → reviewer via SprintRunner
 *   --mode solo    — single agent via PromptRouter
 *   --mode collab  — multi-agent chain (coder → reviewer → coder, etc.)
 *   --mode auto    — sprint for multi-step goals, solo for simple ones
 *   --mode chat    — alias for solo (backward compatibility)
 *
 * Agent tool calls write to a dedicated project directory (not cwd):
 *   ~/personal/openpawl-test-projects/<goal-slug>-<timestamp>/
 *   Override with --workdir <path>
 *
 * Usage: openpawl run --headless --goal "..." [--runs N] [--mode sprint|solo|collab|auto] [--workdir path]
 */

import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";
import { formatDuration, formatToolTarget } from "../utils/formatters.js";
import { SprintEvent, ToolEvent } from "../router/event-types.js";
import { join, resolve } from "node:path";
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

type RunMode = "sprint" | "solo" | "collab" | "auto";

interface HeadlessOptions {
  goal: string;
  runs: number;
  mode: RunMode;
  workdir: string | null;
  template: string | null;
}

function parseArgs(args: string[]): HeadlessOptions {
  let goal = "";
  let runs = 1;
  let mode: RunMode = "auto";
  let workdir: string | null = null;
  let template: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--goal" && args[i + 1]) {
      goal = args[++i]!;
    } else if (arg === "--runs" && args[i + 1]) {
      runs = parseInt(args[++i]!, 10) || 1;
    } else if (arg === "--mode" && args[i + 1]) {
      const m = args[++i]!;
      if (m === "sprint" || m === "solo" || m === "collab" || m === "auto") mode = m;
      else if (m === "chat") mode = "solo"; // backward compatibility
      else if (m === "team") mode = "collab"; // backward compatibility
    } else if (arg === "--workdir" && args[i + 1]) {
      const raw = args[++i]!;
      // Expand ~ to home directory (Node doesn't do this automatically)
      const expanded = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
      workdir = resolve(expanded);
    } else if (arg === "--template" && args[i + 1]) {
      template = args[++i]!;
    } else if (arg === "--headless") {
      // already handled by caller
    } else if (!arg.startsWith("-") && !goal) {
      goal = arg;
    }
  }

  if (!goal) {
    console.error("Usage: openpawl run --headless --goal \"<prompt>\" [--runs N] [--mode sprint|solo|collab|auto] [--workdir path] [--template name]");
    process.exit(1);
  }

  return { goal, runs, mode, workdir, template };
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
  const effectiveMode: "sprint" | "solo" | "collab" = opts.mode === "auto"
    ? (isComplexGoal(opts.goal) ? "sprint" : "solo")
    : opts.mode;

  // Resolve working directory for agent tool calls
  const testProjectsBase = join(homedir(), "personal", "openpawl-test-projects");
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
  const projectDir = opts.workdir ?? join(testProjectsBase, `${goalSlug(opts.goal)}-${dateStr}-${timeStr}`);
  mkdirSync(projectDir, { recursive: true });

  const originalCwd = process.cwd();

  // Resolve team context
  const { resolveTeamContext, resolveFromTemplate } = await import("../sprint/team-resolver.js");
  const teamContext = opts.template
    ? await resolveFromTemplate(opts.template)
    : await resolveTeamContext();

  console.log(pc.bold("openpawl headless mode"));
  console.log(pc.dim(`Goal: ${opts.goal}`));
  console.log(pc.dim(`Mode: ${effectiveMode} | Runs: ${opts.runs}`));
  if (teamContext) {
    console.log(pc.dim(`Template: ${teamContext.templateName} (${teamContext.pipeline.join(" → ")})`));
  }
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

  // Wire debug logging (opt-in via OPENPAWL_DEBUG=true)
  if (process.env.OPENPAWL_DEBUG) {
    const { setDebugSessionId } = await import("../debug/logger.js");
    const { wireDebugToToolExecutor, logStartupInfo } = await import("../debug/wiring.js");
    setDebugSessionId(effectiveMode);
    wireDebugToToolExecutor(toolExec);
    logStartupInfo({
      mode: effectiveMode,
      template: opts.template ?? undefined,
      goal: opts.goal,
      workdir: projectDir,
      runs: opts.runs,
    });
  }

  let accumulatedLessons: string[] = [];

  for (let run = 0; run < opts.runs; run++) {
    if (opts.runs > 1) {
      console.log(pc.bold(`\n── Run ${run + 1}/${opts.runs} ──`));
    }

    // Show lessons being applied
    if (accumulatedLessons.length > 0 && effectiveMode === "sprint") {
      console.log(pc.dim(`  [applying ${accumulatedLessons.length} lesson${accumulatedLessons.length === 1 ? "" : "s"} from previous run${accumulatedLessons.length === 1 ? "" : "s"}]`));
      if (process.env.OPENPAWL_DEBUG) {
        const { debugLog, truncateStr, TRUNCATION } = await import("../debug/logger.js");
        debugLog("info", "sprint", "sprint:lesson_injection", {
          data: {
            run: run + 1,
            lessonCount: accumulatedLessons.length,
            lessons: accumulatedLessons.map((l) => truncateStr(l, TRUNCATION.lessonText)),
          },
        });
      }
    }

    // Switch to the project directory for agent tool calls
    process.chdir(projectDir);

    const runStart = Date.now();

    if (effectiveMode === "sprint") {
      let result: import("../sprint/types.js").SprintResult;
      try {
        result = await runSprint(opts.goal, toolReg, toolExec, teamContext, accumulatedLessons);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n  ${pc.red(ICONS.error)} Sprint failed: ${msg}`);
        console.log(pc.dim(`  Total: ${formatDuration(Date.now() - runStart)}`));
        break;
      }

      console.log("");
      console.log(pc.dim("─".repeat(60)));

      // Per-task failure summary
      const failedTasks = result.tasks.filter((t) => t.status !== "completed");
      if (failedTasks.length > 0) {
        for (const t of failedTasks) {
          console.log(`  ${pc.red(ICONS.error)} ${t.description.slice(0, 70)} — ${pc.dim(t.error?.slice(0, 80) ?? t.status)}`);
        }
      }

      const tokenStr = (result.inputTokens > 0 || result.outputTokens > 0)
        ? ` | Tokens: ${result.inputTokens}in/${result.outputTokens}out`
        : "";
      console.log(
        `Tasks: ${result.completedTasks}/${result.tasks.length} completed | ` +
        `Failed: ${result.failedTasks} | ` +
        `Duration: ${formatDuration(result.duration)}${tokenStr}`,
      );

      // Early exit if all tasks completed successfully (no failures, no incomplete)
      if (result.failedTasks === 0 && result.completedTasks === result.tasks.length) {
        if (run < opts.runs - 1) {
          console.log(pc.green("\nAll tasks passed — stopping early."));
        }
        break;
      }

      // Post-mortem analysis — always run when there are failures (Item 5)
      if (result.failedTasks > 0) {
        const { analyzeRunResult } = await import("../sprint/post-mortem.js");
        const postMortem = analyzeRunResult(result, accumulatedLessons);
        if (postMortem.lessons.length > 0) {
          console.log(`\n  ${pc.cyan("[post-mortem]")} ${postMortem.lessons.length} lesson${postMortem.lessons.length === 1 ? "" : "s"} extracted`);
          for (const lesson of postMortem.lessons) {
            console.log(`    ${pc.dim("-")} ${lesson}`);
          }
        }
        if (run < opts.runs - 1) {
          accumulatedLessons = [...accumulatedLessons, ...postMortem.lessons].slice(0, 10);
        }
      }
    } else {
      if (effectiveMode === "collab") {
        await runCollab(opts.goal, sessionMgr, toolReg, toolExec);
      } else {
        await runSolo(opts.goal, sessionMgr, toolReg, toolExec);
      }

      const runDuration = Date.now() - runStart;
      console.log("");
      console.log(pc.dim("─".repeat(60)));
      console.log(`Total: ${pc.bold(formatDuration(runDuration))}`);
    }
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

  // Close debug log
  if (process.env.OPENPAWL_DEBUG) {
    const { closeDebugLog, getDebugLogPath } = await import("../debug/logger.js");
    const logPath = getDebugLogPath();
    closeDebugLog();
    if (logPath) {
      console.log(`\n${pc.dim(`Debug log: ${logPath}`)}`);
    }
  }

  console.log(`\n${pc.dim(`Project files: ${projectDir}`)}`);

  await sessionMgr.shutdown();
}

// ── Sprint mode ───────────────────────────────────────────────────────

async function runSprint(
  goal: string,
  toolReg: ToolRegistry,
  toolExec: ToolExecutor,
  teamContext?: import("../sprint/types.js").SprintTeamContext,
  lessons?: string[],
): Promise<import("../sprint/types.js").SprintResult> {
  const agents = new AgentRegistry();
  const runner = createSprintRunner({ agents, toolRegistry: toolReg, toolExecutor: toolExec });

  // Wire debug logging to sprint runner
  if (process.env.OPENPAWL_DEBUG) {
    const { wireDebugToSprintRunner } = await import("../debug/wiring.js");
    wireDebugToSprintRunner(runner);
  }

  const taskStartMap = new Map<string, number>();

  runner.on(SprintEvent.Composition, ({ entries }: { entries: Array<{ role: string; task: string; included: boolean; reason: string }> }) => {
    console.log(`  ${pc.bold("Team composition (autonomous):")}`);
    for (const entry of entries) {
      const icon = entry.included ? pc.green(ICONS.success) : pc.dim(ICONS.error);
      const label = entry.included ? entry.role : pc.dim(entry.role);
      const reason = pc.dim(`— ${entry.reason}`);
      console.log(`    ${icon} ${label} ${reason}`);
    }
    console.log("");
  });

  runner.on(SprintEvent.Planning, () => {
    process.stdout.write(`  ${pc.cyan("[planner]")} planning tasks...`);
    taskStartMap.set("__planner__", Date.now());
  });

  runner.on(SprintEvent.Plan, ({ tasks }) => {
    const elapsed = Date.now() - (taskStartMap.get("__planner__") ?? Date.now());
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
    taskStartMap.set(task.id, Date.now());
    process.stdout.write(`  ${pc.cyan(`[${agentName}]`)} ${task.description.slice(0, 60)}`);
  });

  runner.on(SprintEvent.AgentTool, ({ toolName, status, details }: { toolName: string; status: string; details?: { inputSummary?: string } }) => {
    if (status === "running") {
      const target = formatToolTarget(details?.inputSummary);
      const label = target ? `${toolName} ${target}` : toolName;
      process.stdout.write(`\n    ${pc.dim(label)}`);
    } else if (status === "completed") {
      process.stdout.write(pc.dim(` ${ICONS.success}`));
    } else if (status === "failed") {
      process.stdout.write(pc.red(` ${ICONS.error}`));
    }
  });

  runner.on(SprintEvent.TaskComplete, ({ task, taskIndex, totalTasks }: { task: import("../sprint/types.js").SprintTask; taskIndex?: number; totalTasks?: number }) => {
    const elapsed = Date.now() - (taskStartMap.get(task.id) ?? Date.now());
    const status = task.status === "completed" ? pc.green("done")
      : task.status === "failed" ? pc.red("failed")
      : pc.yellow("incomplete");
    const progress = (taskIndex != null && totalTasks != null) ? ` ${pc.dim(`[${taskIndex}/${totalTasks}]`)}` : "";
    process.stdout.write(` ${pc.dim(ICONS.arrow)} ${status} (${formatDuration(elapsed)})${progress}\n`);
    if (task.status !== "completed" && task.error) {
      console.log(`    ${pc.red(task.error.slice(0, 120))}`);
    }
  });

  runner.on(SprintEvent.NeedsClarification, ({ questions }: { questions: string[] }) => {
    console.log("");
    console.log(`  ${pc.yellow(ICONS.warning)} Goal needs clarification:`);
    for (const q of questions) {
      console.log(`    ${pc.dim("?")} ${q}`);
    }
    console.log("");
    console.log(pc.dim("  Provide a more specific goal and try again."));
    process.exitCode = 2;
  });

  runner.on(SprintEvent.Warning, ({ warning }) => {
    console.log(`  ${pc.yellow(ICONS.warning)} ${warning}`);
  });

  runner.on(SprintEvent.Error, ({ error }) => {
    console.error(`  ${pc.red(ICONS.error)} ${error.message}`);
  });

  const result = await runner.run(goal, {
    ...(teamContext ? { teamContext } : {}),
    ...(lessons && lessons.length > 0 ? { lessons } : {}),
  });

  // Generate CONTEXT.md handoff
  try {
    const { buildHandoffData, renderContextMarkdown } = await import("../handoff/index.js");
    const md = renderContextMarkdown(buildHandoffData({
      sessionId: `sprint-${Date.now()}`,
      projectPath: process.cwd(),
      goal,
      taskQueue: result.tasks.map((t) => ({ ...t })),
      nextSprintBacklog: result.tasks.filter((t) => t.status === "failed").map((t) => ({ ...t })),
      promotedThisRun: [],
      agentProfiles: [],
      activeDecisions: [],
      rfcDocument: null,
    }));
    const contextPath = join(process.cwd(), "CONTEXT.md");
    writeFileSync(contextPath, md);
    console.log(pc.dim(`Handoff saved: ${contextPath}`));
  } catch {
    // Handoff generation is non-critical
  }

  return result;
}

// ── Solo mode (single agent via PromptRouter) ─────────────────────────

async function runSolo(
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
    onToolCall: (_agentId, toolName, status, details) => {
      if (status === "running") {
        const target = formatToolTarget(details?.inputSummary as string | undefined);
        const label = target ? `${toolName} ${target}` : toolName;
        process.stdout.write(`\n    ${pc.dim(label)}`);
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
        const text = result.value.fullOutput || JSON.stringify(result.value.data) || result.value.summary;
        const data = result.value.data as Record<string, unknown> | undefined;
        const diff = data?.diff as import("../utils/diff.js").DiffResult | undefined;
        return diff ? { text, diff } : text;
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

  // Wire debug logging to router
  if (process.env.OPENPAWL_DEBUG) {
    const { wireDebugToRouter } = await import("../debug/wiring.js");
    wireDebugToRouter(router);
  }

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

// ── Collab mode (multi-agent chain via PromptRouter) ──────────────────

async function runCollab(
  goal: string,
  sessionMgr: ReturnType<typeof createSessionManager>,
  toolReg: ToolRegistry,
  toolExec: ToolExecutor,
): Promise<void> {
  const { buildCollabChain } = await import("../router/collab-dispatch.js");
  const chain = buildCollabChain(goal, { force: true });

  if (!chain) {
    console.log(pc.dim("No collab chain detected — falling back to solo mode"));
    return runSolo(goal, sessionMgr, toolReg, toolExec);
  }

  console.log(pc.bold("Collab chain:"), chain.steps.map((s) => s.agentId).join(" → "));
  console.log("");

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
    onToolCall: (_agentId, toolName, status, details) => {
      if (status === "running") {
        const target = formatToolTarget(details?.inputSummary as string | undefined);
        const label = target ? `${toolName} ${target}` : toolName;
        process.stdout.write(`\n    ${pc.dim(label)}`);
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
        const text = result.value.fullOutput || JSON.stringify(result.value.data) || result.value.summary;
        const data = result.value.data as Record<string, unknown> | undefined;
        const diff = data?.diff as import("../utils/diff.js").DiffResult | undefined;
        return diff ? { text, diff } : text;
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

  // Wire debug logging to router
  if (process.env.OPENPAWL_DEBUG) {
    const { wireDebugToRouter } = await import("../debug/wiring.js");
    wireDebugToRouter(router);
  }

  const result = await router.route(session.id, goal, { appMode: "collab" });

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
