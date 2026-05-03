/**
 * Headless mode — runs a single agent without TUI rendering.
 *
 * Currently only `solo` is supported. `sprint` and `collab` were removed
 * as part of the v0.4 crew migration; once Crew lands it will plug in
 * alongside `runSolo` here.
 *
 * Usage: openpawl run --headless --goal "..." [--runs N] [--mode solo] [--workdir path]
 */

import pc from "picocolors";
import { ICONS } from "../tui/constants/icons.js";
import { formatDuration, formatToolTarget } from "../utils/formatters.js";
import { ToolEvent } from "../router/event-types.js";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { createSessionManager } from "../session/index.js";
import { PromptRouter } from "../router/index.js";
import { createLLMAgentRunner } from "../router/llm-agent-runner.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolExecutor } from "../tools/executor.js";
import { PermissionResolver } from "../tools/permissions.js";
import { registerBuiltInTools } from "../tools/built-in/index.js";
import {
  profileStart,
  isProfilingEnabled,
  generateReport as generateProfileReport,
} from "../telemetry/profiler.js";

type RunMode = "solo";

interface HeadlessOptions {
  goal: string;
  runs: number;
  mode: RunMode;
  workdir: string | null;
}

function parseArgs(args: string[]): HeadlessOptions {
  let goal = "";
  let runs = 1;
  const mode: RunMode = "solo";
  let workdir: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--goal" && args[i + 1]) {
      goal = args[++i]!;
    } else if (arg === "--runs" && args[i + 1]) {
      runs = parseInt(args[++i]!, 10) || 1;
    } else if (arg === "--mode" && args[i + 1]) {
      // Only solo is supported in headless right now; aliases collapse to solo.
      i++;
    } else if (arg === "--workdir" && args[i + 1]) {
      const raw = args[++i]!;
      const expanded = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
      workdir = resolve(expanded);
    } else if (arg === "--template" && args[i + 1]) {
      // Templates were sprint-scoped; ignore for now (consumed by future crew).
      i++;
    } else if (arg === "--headless") {
      // already handled by caller
    } else if (!arg.startsWith("-") && !goal) {
      goal = arg;
    }
  }

  if (!goal) {
    console.error("Usage: openpawl run --headless --goal \"<prompt>\" [--runs N] [--mode solo] [--workdir path]");
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

export async function runHeadless(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const finishTotal = profileStart("total_pipeline", "headless");

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
  console.log(pc.dim(`Mode: ${opts.mode} | Runs: ${opts.runs}`));
  console.log(pc.dim(`Project dir: ${projectDir}`));
  console.log("");

  // Initialize session manager
  const sessionMgr = createSessionManager();
  await sessionMgr.initialize();

  // Initialize tool registry + executor
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
    setDebugSessionId(opts.mode);
    wireDebugToToolExecutor(toolExec);
    logStartupInfo({
      mode: opts.mode,
      goal: opts.goal,
      workdir: projectDir,
      runs: opts.runs,
    });
  }

  for (let run = 0; run < opts.runs; run++) {
    if (opts.runs > 1) {
      console.log(pc.bold(`\n── Run ${run + 1}/${opts.runs} ──`));
    }

    // Switch to the project directory for agent tool calls
    process.chdir(projectDir);

    const runStart = Date.now();

    await runSolo(opts.goal, sessionMgr, toolReg, toolExec);

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
            ` ${pc.dim("→")} ${pc.green("done")} (${formatDuration(elapsed)}, ${tokenCount} tokens)\n`,
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
        const shell = toolName === "shell_exec" && data
          ? { exitCode: data.exitCode as number | undefined, stderrHead: typeof data.stderr === "string" ? (data.stderr as string).slice(0, 200) : undefined }
          : undefined;
        const success = result.value.success;
        if (diff || shell) {
          return { text, diff, success, exitCode: shell?.exitCode, stderrHead: shell?.stderrHead };
        }
        return text;
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
      ` ${pc.dim("→")} ${pc.green("done")} (${formatDuration(elapsed)}, ${tokenCount} tokens)\n`,
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
      console.log(pc.dim("─".repeat(60)));
      console.log(`${pc.bold(`[${agentResult.agentId}]`)} ${pc.red("error")}`);
      console.log(pc.red(agentResult.error));
    } else if (agentResult.response) {
      console.log(pc.dim("─".repeat(60)));
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
