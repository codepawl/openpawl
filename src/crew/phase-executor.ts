/**
 * Phase executor — drives a single phase through DAG-aware parallelism
 * per spec §5.3 and §5.4.
 *
 * Responsibilities:
 *   - Topologically sort the phase's tasks by `depends_on`.
 *   - Group ready tasks into waves; tasks in the same wave run in
 *     parallel up to MAX_PARALLEL_TASKS = min(4, agent_count).
 *   - For each task: run the budget pre-flight, build the per-task
 *     prompt with the known-files block + prior-tasks block, dispatch
 *     through `runSubagent`, validate the disk outcome, classify any
 *     error, decide retry vs block, update the doom-loop detector.
 *   - Enforce a tier-scaled phase time budget (§6.2): Tier 1 → 5 min,
 *     Tier 2 → 15 min, Tier 3 → 30 min. On timeout, in-progress tasks
 *     are signalled to abort and pending tasks are marked blocked.
 *
 * The function mutates `phase.tasks` in place (statuses, error fields,
 * tokens, wall-time) and returns a result object the runner uses to
 * build the `PhaseSummaryArtifact` and to advance bookkeeping.
 *
 * Out of scope (next PR): discussion meeting, drift check, context
 * compaction, user checkpoint UI.
 */

import { debugLog } from "../debug/logger.js";

import {
  type ArtifactStoreReader,
} from "./artifacts/index.js";
import { BudgetTracker } from "./budget-tracker.js";
import { DoomLoopDetector } from "./doom-loop.js";
import {
  classifyTaskError,
  shouldRetry,
  type ErrorSignal,
} from "./error-classify.js";
import { KnownFilesRegistry } from "./known-files.js";
import type { AgentDefinition, CrewManifest } from "./manifest/index.js";
import {
  runSubagent as defaultRunSubagent,
  type RunSubagentArgs,
  type SubagentDebugInfo,
  type SubagentResult,
} from "./subagent-runner.js";
import { validateTaskCompletion } from "./validator.js";
import type { CrewPhase, CrewTask, ComplexityTier } from "./types.js";
import { WriteLockManager } from "./write-lock.js";
import type { ToolCallSummary } from "../router/router-types.js";

export const MAX_PARALLEL_TASKS_HARD_CAP = 4;

const TIER_TIME_BUDGET_MS: Record<ComplexityTier, number> = {
  "1": 5 * 60_000,
  "2": 15 * 60_000,
  "3": 30 * 60_000,
};

export interface ExecutePhaseArgs {
  phase: CrewPhase;
  manifest: CrewManifest;
  workdir: string;
  artifact_reader: ArtifactStoreReader;
  write_lock_manager: WriteLockManager;
  known_files: KnownFilesRegistry;
  budget_tracker: BudgetTracker;
  session_id: string;
  doom_loop?: DoomLoopDetector;
  /** Test seam — defaults to the real {@link runSubagent}. */
  runSubagentImpl?: (args: RunSubagentArgs) => Promise<SubagentResult>;
  /** External abort (e.g. global session abort). The phase timer is internal. */
  signal?: AbortSignal;
  /** Override the tier-scaled default. Mostly for tests. */
  phase_time_budget_ms?: number;
  /** Override the parallelism bound (default: min(4, agents.length)). */
  max_parallel_tasks?: number;
}

export interface ExecutePhaseResult {
  phase_id: string;
  task_count: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
    incomplete: number;
  };
  files_created: string[];
  files_modified: string[];
  tokens_used: number;
  wall_time_ms: number;
  ended_by: "all_complete" | "time_budget" | "session_budget" | "abort_signal";
}

// ── Topological sort + wave selection ──────────────────────────────────

function isTerminal(status: CrewTask["status"]): boolean {
  return (
    status === "completed" ||
    status === "incomplete" ||
    status === "failed" ||
    status === "blocked"
  );
}

/**
 * A task is "ready" when:
 *   - status is pending
 *   - every in-phase dependency has reached a terminal state
 *
 * Cross-phase deps are assumed satisfied — the runner only enters a
 * phase after the prior phase has fully terminated.
 */
function readyTasks(phase: CrewPhase): CrewTask[] {
  const inPhaseTaskIds = new Set(phase.tasks.map((t) => t.id));
  const status = new Map(phase.tasks.map((t) => [t.id, t.status]));
  const ready: CrewTask[] = [];
  for (const task of phase.tasks) {
    if (task.status !== "pending") continue;
    const inPhaseDeps = task.depends_on.filter((d) => inPhaseTaskIds.has(d));
    const allTerminal = inPhaseDeps.every((d) => {
      const s = status.get(d);
      return s !== undefined && isTerminal(s);
    });
    if (allTerminal) ready.push(task);
  }
  return ready;
}

function pendingCount(phase: CrewPhase): number {
  return phase.tasks.filter((t) => t.status === "pending").length;
}

// ── Tool-call extraction ───────────────────────────────────────────────

function safeParseInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function pathFrom(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file", "filename"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

interface FileChanges {
  created: string[];
  modified: string[];
}

export function extractFileChangesFromToolCalls(
  toolCalls: ToolCallSummary[],
): FileChanges {
  const created = new Set<string>();
  const modified = new Set<string>();
  for (const tc of toolCalls) {
    if (!tc.success) continue;
    const args = safeParseInput(tc.input);
    const path = pathFrom(args);
    if (!path) continue;
    if (tc.tool === "file_write") created.add(path);
    else if (tc.tool === "file_edit") modified.add(path);
  }
  return { created: [...created], modified: [...modified] };
}

// ── Prompt assembly ────────────────────────────────────────────────────

function buildTaskPrompt(args: {
  task: CrewTask;
  agentDef: AgentDefinition;
  knownFilesBlock: string;
  priorTasksBlock: string;
}): string {
  const { task, knownFilesBlock, priorTasksBlock } = args;
  const sections = [`# Task ${task.id}\n\n${task.description}`];
  if (knownFilesBlock) sections.push(knownFilesBlock);
  if (priorTasksBlock) sections.push(priorTasksBlock);
  return sections.join("\n\n");
}

function buildPriorTasksBlock(phase: CrewPhase, currentTaskId: string): string {
  const completed = phase.tasks.filter(
    (t) => t.id !== currentTaskId && t.status === "completed",
  );
  if (completed.length === 0) return "";
  const lines = ["## Prior tasks completed in this phase"];
  for (const t of completed) {
    const filesTouched = [...t.files_created, ...t.files_modified];
    const filesLine =
      filesTouched.length > 0 ? ` (files: ${filesTouched.join(", ")})` : "";
    const result = t.result ? ` — ${t.result.slice(0, 200)}` : "";
    lines.push(`- ${t.id} [${t.assigned_agent}]: ${t.description}${filesLine}${result}`);
  }
  return lines.join("\n");
}

// ── Single-task execution ──────────────────────────────────────────────

interface RunOnceOutcome {
  status: "completed" | "validator_failed" | "agent_error" | "budget_blocked";
  signal?: ErrorSignal;
  files_created: string[];
  files_modified: string[];
  tokens_input: number;
  tokens_output: number;
  summary: string;
  tool_calls: ToolCallSummary[];
}

const PROMPT_TOKEN_HEURISTIC = (text: string): number => Math.ceil(text.length / 4);

async function runTaskOnce(args: {
  task: CrewTask;
  agentDef: AgentDefinition;
  prompt: string;
  budget: BudgetTracker;
  artifactReader: ArtifactStoreReader;
  writeLockManager: WriteLockManager;
  sessionId: string;
  workdir: string;
  signal?: AbortSignal;
  runSubagent: (a: RunSubagentArgs) => Promise<SubagentResult>;
}): Promise<RunOnceOutcome> {
  const estIn = PROMPT_TOKEN_HEURISTIC(args.prompt) + PROMPT_TOKEN_HEURISTIC(args.agentDef.prompt);
  const estOut = Math.min(8_000, Math.floor(args.task.max_tokens_per_task / 5));
  const budgetCheck = args.budget.checkBeforeTask(args.task, estIn, estOut);
  if (!budgetCheck.allowed) {
    debugLog("warn", "crew", "phase:task_budget_blocked", {
      data: {
        task_id: args.task.id,
        scope: budgetCheck.scope,
        cap: budgetCheck.cap,
        current: budgetCheck.current,
      },
    });
    return {
      status: "budget_blocked",
      files_created: [],
      files_modified: [],
      tokens_input: 0,
      tokens_output: 0,
      summary: budgetCheck.message,
      tool_calls: [],
      signal: {
        source: "agent_error",
        message: `budget_exceeded(${budgetCheck.scope}): ${budgetCheck.message}`,
      },
    };
  }

  let debugInfo: SubagentDebugInfo | null = null;
  let result: SubagentResult;
  try {
    result = await args.runSubagent({
      agent_def: args.agentDef,
      prompt: args.prompt,
      artifact_reader: args.artifactReader,
      depth: 0,
      parent_agent_id: "phase-executor",
      write_lock_manager: args.writeLockManager,
      session_id: args.sessionId,
      token_budget: {
        max_input: args.task.max_tokens_per_task,
        max_output: estOut,
      },
      signal: args.signal,
      onDebug: (info) => {
        debugInfo = info;
      },
    });
  } catch (err) {
    return {
      status: "agent_error",
      files_created: [],
      files_modified: [],
      tokens_input: 0,
      tokens_output: 0,
      summary: err instanceof Error ? err.message : String(err),
      tool_calls: [],
      signal: {
        source: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const toolCalls = (debugInfo as SubagentDebugInfo | null)?.tool_calls ?? [];
  const breakdown = result.tokens_breakdown ?? {
    input: result.tokens_used,
    output: 0,
  };
  const changes = extractFileChangesFromToolCalls(toolCalls);

  // Apply claimed file changes BEFORE validator so the task fields are
  // populated for the validator's check.
  const taskWithClaims: CrewTask = {
    ...args.task,
    files_created: [...new Set([...args.task.files_created, ...changes.created])],
    files_modified: [...new Set([...args.task.files_modified, ...changes.modified])],
  };

  const validation = validateTaskCompletion(taskWithClaims, args.workdir);
  if (!validation.ok) {
    return {
      status: "validator_failed",
      files_created: changes.created,
      files_modified: changes.modified,
      tokens_input: breakdown.input,
      tokens_output: breakdown.output,
      summary: result.summary,
      tool_calls: toolCalls,
      signal: { source: "validator", reason: validation.reason },
    };
  }

  // Surface failed shell calls as classification signals so a tool-only
  // exit-127 still drives the env-classifier path without a thrown
  // exception. Pick the first non-success shell call as the exemplar.
  const failedShell = toolCalls.find(
    (tc) => tc.tool === "shell_exec" && tc.success === false,
  );
  if (failedShell) {
    return {
      status: "agent_error",
      files_created: changes.created,
      files_modified: changes.modified,
      tokens_input: breakdown.input,
      tokens_output: breakdown.output,
      summary: result.summary,
      tool_calls: toolCalls,
      signal: {
        source: "shell_exec",
        exit_code: failedShell.exitCode ?? 1,
        stderr: failedShell.stderrHead ?? "",
      },
    };
  }

  return {
    status: "completed",
    files_created: changes.created,
    files_modified: changes.modified,
    tokens_input: breakdown.input,
    tokens_output: breakdown.output,
    summary: result.summary,
    tool_calls: toolCalls,
  };
}

async function executeTaskWithRetries(args: {
  task: CrewTask;
  agentDef: AgentDefinition;
  phase: CrewPhase;
  knownFilesBlock: string;
  budget: BudgetTracker;
  artifactReader: ArtifactStoreReader;
  writeLockManager: WriteLockManager;
  sessionId: string;
  workdir: string;
  signal?: AbortSignal;
  doomLoop: DoomLoopDetector;
  runSubagent: (a: RunSubagentArgs) => Promise<SubagentResult>;
}): Promise<void> {
  const startedAt = Date.now();
  args.task.status = "in_progress";

  let totalIn = 0;
  let totalOut = 0;
  let lastToolCalls: ToolCallSummary[] = [];
  const allCreated = new Set<string>();
  const allModified = new Set<string>();
  let attempt = 0;

  while (true) {
    if (args.signal?.aborted) {
      args.task.status = "blocked";
      args.task.error = "phase aborted";
      break;
    }

    const priorTasksBlock = buildPriorTasksBlock(args.phase, args.task.id);
    const prompt = buildTaskPrompt({
      task: args.task,
      agentDef: args.agentDef,
      knownFilesBlock: args.knownFilesBlock,
      priorTasksBlock,
    });

    const outcome = await runTaskOnce({
      task: args.task,
      agentDef: args.agentDef,
      prompt,
      budget: args.budget,
      artifactReader: args.artifactReader,
      writeLockManager: args.writeLockManager,
      sessionId: args.sessionId,
      workdir: args.workdir,
      signal: args.signal,
      runSubagent: args.runSubagent,
    });

    totalIn += outcome.tokens_input;
    totalOut += outcome.tokens_output;
    for (const p of outcome.files_created) allCreated.add(p);
    for (const p of outcome.files_modified) allModified.add(p);
    lastToolCalls = outcome.tool_calls;

    args.budget.recordTaskTokens({
      task_id: args.task.id,
      phase_id: args.task.phase_id,
      input: outcome.tokens_input,
      output: outcome.tokens_output,
    });

    if (outcome.status === "completed") {
      args.task.status = "completed";
      args.task.result = outcome.summary.slice(0, 2_000);
      args.task.files_created = [...allCreated];
      args.task.files_modified = [...allModified];
      args.task.input_tokens = totalIn;
      args.task.output_tokens = totalOut;
      args.task.wall_time_ms = Date.now() - startedAt;
      args.task.retry_count = attempt;
      args.task.tool_calls = lastToolCalls.map((tc) => ({
        tool: tc.tool,
        input: tc.input,
      }));
      args.doomLoop.reset(args.task.id);
      return;
    }

    if (outcome.status === "budget_blocked") {
      args.task.status = "blocked";
      args.task.error = outcome.summary;
      args.task.error_kind = "unknown";
      args.task.input_tokens = totalIn;
      args.task.output_tokens = totalOut;
      args.task.wall_time_ms = Date.now() - startedAt;
      args.task.retry_count = attempt;
      return;
    }

    // Classify and decide retry.
    const signal = outcome.signal!;
    const classification = classifyTaskError(signal, args.task);

    const dlRecord = args.doomLoop.record({
      agent_id: args.task.assigned_agent,
      task_id: args.task.id,
      error_kind: classification.kind,
      exit_code:
        signal.source === "shell_exec" ? signal.exit_code : undefined,
    });

    args.task.error = classification.reason;
    args.task.error_kind = classification.kind;

    const retryAllowed = !dlRecord.blocked && shouldRetry(classification, attempt);
    if (!retryAllowed) {
      // Final outcome: env_* or timeout → blocked. agent_logic / unknown
      // that ran out of retries → failed.
      const isEnv =
        classification.kind === "env_command_not_found" ||
        classification.kind === "env_missing_dep" ||
        classification.kind === "env_perm" ||
        classification.kind === "env_port_in_use" ||
        classification.kind === "timeout";
      args.task.status = dlRecord.blocked ? "blocked" : isEnv ? "blocked" : "failed";
      args.task.input_tokens = totalIn;
      args.task.output_tokens = totalOut;
      args.task.wall_time_ms = Date.now() - startedAt;
      args.task.retry_count = attempt;
      args.task.files_created = [...allCreated];
      args.task.files_modified = [...allModified];
      args.task.last_shell_failure =
        signal.source === "shell_exec" ? signal : undefined;
      debugLog("info", "crew", "phase:task_terminal_failure", {
        data: {
          task_id: args.task.id,
          status: args.task.status,
          error_kind: classification.kind,
          attempts: attempt + 1,
          doom_loop_blocked: dlRecord.blocked,
        },
      });
      return;
    }

    attempt += 1;
    debugLog("info", "crew", "phase:task_retry", {
      data: {
        task_id: args.task.id,
        agent: args.task.assigned_agent,
        kind: classification.kind,
        attempt: attempt,
      },
    });
  }
}

// ── Main entry point ───────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function executePhase(
  args: ExecutePhaseArgs,
): Promise<ExecutePhaseResult> {
  const start = Date.now();
  const runSubagent = args.runSubagentImpl ?? defaultRunSubagent;
  const doomLoop = args.doom_loop ?? new DoomLoopDetector();
  const maxParallel =
    args.max_parallel_tasks ??
    Math.min(MAX_PARALLEL_TASKS_HARD_CAP, Math.max(1, args.manifest.agents.length));

  const tier = args.phase.complexity_tier;
  const phaseBudgetMs = args.phase_time_budget_ms ?? TIER_TIME_BUDGET_MS[tier];

  const phaseAbort = new AbortController();
  const phaseTimer = setTimeout(() => phaseAbort.abort(), phaseBudgetMs);
  if (typeof phaseTimer.unref === "function") phaseTimer.unref();

  const externalSignal = args.signal;
  const onExternalAbort = () => phaseAbort.abort();
  if (externalSignal) {
    if (externalSignal.aborted) phaseAbort.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const agentById = new Map(args.manifest.agents.map((a) => [a.id, a]));

  let endedBy: ExecutePhaseResult["ended_by"] = "all_complete";

  debugLog("info", "crew", "phase:start", {
    data: {
      phase_id: args.phase.id,
      task_count: args.phase.tasks.length,
      complexity_tier: args.phase.complexity_tier,
      time_budget_ms: phaseBudgetMs,
      max_parallel: maxParallel,
    },
  });

  try {
    while (pendingCount(args.phase) > 0) {
      if (phaseAbort.signal.aborted) {
        endedBy = externalSignal?.aborted ? "abort_signal" : "time_budget";
        break;
      }
      if (args.budget_tracker.isSessionExhausted()) {
        endedBy = "session_budget";
        break;
      }

      const ready = readyTasks(args.phase);
      if (ready.length === 0) {
        // Deadlock — cross-phase deps from a non-terminal task here, or the
        // remaining tasks all have unmet in-phase deps because their
        // dependencies were already marked failed/blocked. Mark the
        // remaining pendings blocked with a clear reason and stop.
        for (const t of args.phase.tasks) {
          if (t.status === "pending") {
            t.status = "blocked";
            t.error = "blocked: dependency did not complete";
            t.error_kind = "unknown";
          }
        }
        break;
      }

      const wave = ready.slice(0, maxParallel);
      const knownFilesBlock = args.known_files.format();

      await Promise.all(
        wave.map(async (task) => {
          const agentDef = agentById.get(task.assigned_agent);
          if (!agentDef) {
            task.status = "failed";
            task.error = `agent '${task.assigned_agent}' not found in manifest`;
            task.error_kind = "agent_logic";
            return;
          }
          await executeTaskWithRetries({
            task,
            agentDef,
            phase: args.phase,
            knownFilesBlock,
            budget: args.budget_tracker,
            artifactReader: args.artifact_reader,
            writeLockManager: args.write_lock_manager,
            sessionId: args.session_id,
            workdir: args.workdir,
            signal: phaseAbort.signal,
            doomLoop,
            runSubagent,
          });
          if (task.status === "completed") {
            args.known_files.addFromTaskResult(task);
          }
        }),
      );
    }

    // Anything still pending after the loop is blocked-by-timeout or
    // blocked-by-session-budget. Mark accordingly.
    if (endedBy !== "all_complete") {
      for (const t of args.phase.tasks) {
        if (t.status === "pending" || t.status === "in_progress") {
          t.status = "blocked";
          t.error =
            endedBy === "session_budget"
              ? "session_budget_exhausted"
              : "phase_time_budget_exceeded";
          t.error_kind = endedBy === "session_budget" ? "unknown" : "timeout";
        }
      }
    }
  } finally {
    clearTimeout(phaseTimer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }

  const taskCount = {
    total: args.phase.tasks.length,
    completed: args.phase.tasks.filter((t) => t.status === "completed").length,
    failed: args.phase.tasks.filter((t) => t.status === "failed").length,
    blocked: args.phase.tasks.filter((t) => t.status === "blocked").length,
    incomplete: args.phase.tasks.filter((t) => t.status === "incomplete").length,
  };

  const filesCreated = new Set<string>();
  const filesModified = new Set<string>();
  let tokensUsed = 0;
  for (const t of args.phase.tasks) {
    for (const p of t.files_created) filesCreated.add(p);
    for (const p of t.files_modified) filesModified.add(p);
    tokensUsed += t.input_tokens + t.output_tokens;
  }

  const wallTimeMs = Date.now() - start;
  args.phase.tokens_used = tokensUsed;

  debugLog("info", "crew", "phase:done", {
    data: {
      phase_id: args.phase.id,
      ended_by: endedBy,
      task_count: taskCount,
      tokens_used: tokensUsed,
      wall_time_ms: wallTimeMs,
    },
  });

  return {
    phase_id: args.phase.id,
    task_count: taskCount,
    files_created: [...filesCreated],
    files_modified: [...filesModified],
    tokens_used: tokensUsed,
    wall_time_ms: wallTimeMs,
    ended_by: endedBy,
  };
}

/** Exposed for tests. */
export const _internal = {
  readyTasks,
  buildPriorTasksBlock,
  buildTaskPrompt,
  chunk,
};
