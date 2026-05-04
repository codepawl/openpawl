/**
 * CrewRunner — top-level multi-agent orchestrator.
 *
 * Current state (this PR): planning step only. The runner loads the
 * configured crew manifest, invokes the Planner agent through the
 * subagent contract, validates and tier-classifies the resulting plan,
 * persists it as a `PlanArtifact`, and returns `{ status: "plan_only" }`.
 *
 * Phase execution, discussion meetings, checkpoints, post-mortems —
 * all later PRs in the v0.4 roadmap.
 *
 * Spec anchors: §5.1 (top-level orchestration), §5.2 (planning phase
 * invariants), §3 Decision 3 (complexity tiers), §4.6 (PlanArtifact),
 * §3 Decision 5 (token budgets, default 50k per task).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";

import { debugLog } from "../debug/logger.js";
import { ArtifactStore, type ArtifactStoreReader } from "./artifacts/index.js";
import type {
  PhaseSummaryArtifact,
  PlanArtifact,
} from "./artifacts/index.js";
import { BudgetTracker } from "./budget-tracker.js";
import { classifyPhaseComplexity } from "./complexity.js";
import { DoomLoopDetector } from "./doom-loop.js";
import { KnownFilesRegistry } from "./known-files.js";
import {
  ensureBuiltInPresets,
  FULL_STACK_PRESET,
  loadUserCrew,
  WRITE_TOOLS,
  type AgentDefinition,
  type CrewManifest,
} from "./manifest/index.js";
import {
  runDiscussionMeeting as defaultRunDiscussionMeeting,
  type MeetingResult,
  type RunDiscussionMeetingArgs,
} from "./meeting/run-meeting.js";
import {
  executePhase as defaultExecutePhase,
  type ExecutePhaseArgs,
  type ExecutePhaseResult,
} from "./phase-executor.js";
import { parsePlan, type ParseError } from "./plan-parser.js";
import {
  runSubagent as defaultRunSubagent,
  type RunSubagentArgs,
  type SubagentResult,
} from "./subagent-runner.js";
import type { CrewPhase, CrewRunOptions } from "./types.js";
import { WriteLockManager } from "./write-lock.js";

export const CREW_RUNNER_PENDING_MESSAGE =
  "crew runner pending — see PR sequence after #105";

export const PLANNER_AGENT_ID = "planner";
export const DEFAULT_MAX_TOKENS_PER_TASK = 50_000;
export const DEFAULT_MAX_TOKENS_PER_PHASE = 200_000;
export const DEFAULT_MAX_TOKENS_PER_SESSION = 1_000_000;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export class PlanFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: ParseError,
  ) {
    super(message);
    this.name = "PlanFailedError";
  }
}

export interface CrewPlanResult {
  status: "plan_only";
  session_id: string;
  crew_name: string;
  goal: string;
  phases: CrewPhase[];
  plan_artifact_id: string;
  tokens_used: number;
}

export interface CrewPlanFailedResult {
  status: "plan_failed";
  session_id: string;
  crew_name: string;
  goal: string;
  error: ParseError;
  attempts: number;
}

export type CrewEndedBy =
  | "all_phases_complete"
  | "session_budget"
  | "abort_signal";

export interface CrewCompletedResult {
  status: "completed" | "halted";
  session_id: string;
  crew_name: string;
  goal: string;
  phases: CrewPhase[];
  plan_artifact_id: string;
  phase_summary_artifact_ids: string[];
  tokens_used: number;
  ended_by: CrewEndedBy;
}

export type CrewRunResult =
  | CrewPlanResult
  | CrewPlanFailedResult
  | CrewCompletedResult;

export interface RunPlanningArgs {
  options: CrewRunOptions;
  /** Override session id; defaults to a fresh UUID. */
  session_id?: string;
  /** Override homeDir for preset seeding + artifact JSONL. Tests pass mkdtemp. */
  home_dir?: string;
  /** Override budget; defaults to {@link DEFAULT_MAX_TOKENS_PER_TASK}. */
  max_tokens_per_task?: number;
  /** Test seam — defaults to the real {@link runSubagent}. */
  runSubagentImpl?: (args: RunSubagentArgs) => Promise<SubagentResult>;
  /** Test seam — preload the manifest instead of going through the loader. */
  manifest?: CrewManifest;
}

export interface RunCrewArgs extends RunPlanningArgs {
  /** Working directory for tasks (file_write etc). Defaults to options.workdir. */
  workdir?: string;
  max_tokens_per_phase?: number;
  max_tokens_per_session?: number;
  /** Per-phase override map keyed by complexity_tier. */
  phase_time_budget_ms_by_tier?: Partial<Record<"1" | "2" | "3", number>>;
  /** Test seam — defaults to the real {@link executePhase}. */
  executePhaseImpl?: (args: ExecutePhaseArgs) => Promise<ExecutePhaseResult>;
  /** Test seam — defaults to the real {@link runDiscussionMeeting}. */
  runDiscussionMeetingImpl?: (args: RunDiscussionMeetingArgs) => Promise<MeetingResult>;
  signal?: AbortSignal;
}

function resolveManifest(
  options: CrewRunOptions,
  homeDir: string,
  override?: CrewManifest,
): CrewManifest {
  if (override) return override;
  ensureBuiltInPresets(homeDir);
  const name = options.crew_name || FULL_STACK_PRESET;
  return loadUserCrew(name, homeDir);
}

function resolvePlannerAgent(manifest: CrewManifest): AgentDefinition {
  const planner = manifest.agents.find((a) => a.id === PLANNER_AGENT_ID);
  if (!planner) {
    throw new ManifestError(
      `crew '${manifest.name}' has no '${PLANNER_AGENT_ID}' agent — required for planning step`,
    );
  }
  const writeTools = planner.tools.filter((t) => WRITE_TOOLS.has(t));
  if (writeTools.length > 0) {
    throw new ManifestError(
      `planner agent in crew '${manifest.name}' has write tools (${writeTools.join(", ")}); ` +
        `planner must be read-only per spec §5.2 invariants`,
    );
  }
  return planner;
}

function buildPlannerPrompt(
  goal: string,
  manifest: CrewManifest,
  retryHint: string | null,
): string {
  const assignableAgents = manifest.agents.filter((a) => a.id !== PLANNER_AGENT_ID);
  const agentList = assignableAgents
    .map(
      (a) =>
        `- ${a.id} (${a.name}): ${a.description.trim()} — tools: ${a.tools.join(", ")}` +
        (a.write_scope?.length ? ` — write_scope: ${a.write_scope.join(", ")}` : ""),
    )
    .join("\n");

  const baseInstructions = `# Goal

${goal}

# Available agents

${agentList}

# Output format

Respond with JSON only — a top-level array of phases. No prose, no code fences. Each phase has this shape:

\`\`\`
{
  "id": "p1",
  "name": "Short phase name",
  "description": "One-sentence purpose of the phase",
  "tasks": [
    {
      "id": "t1",
      "phase_id": "p1",
      "description": "Concrete, atomic action a single agent can complete",
      "assigned_agent": "<one of the agent ids above>",
      "depends_on": []
    }
  ]
}
\`\`\`

# Hard constraints

- Do NOT assign tasks to '${PLANNER_AGENT_ID}'. The planner does not execute work; assign every task to one of: ${assignableAgents.map((a) => a.id).join(", ")}.
- Each task description names exactly one outcome. No "and also" tasks.
- \`depends_on\` references task ids that already exist (in this phase or an earlier one). No forward references.
- No dependency cycles.
- Each phase has at least one task.
`;

  if (retryHint) {
    return `${baseInstructions}\n\n# Retry — your previous output failed validation\n\n${retryHint}\n\nReturn corrected JSON only.\n`;
  }
  return baseInstructions;
}

function tierDistribution(phases: CrewPhase[]): Record<"1" | "2" | "3", number> {
  const dist: Record<"1" | "2" | "3", number> = { "1": 0, "2": 0, "3": 0 };
  for (const p of phases) dist[p.complexity_tier] += 1;
  return dist;
}

/** Run only the planning phase. Returns plan_only or plan_failed. */
export async function runPlanning(args: RunPlanningArgs): Promise<CrewRunResult> {
  const sessionId = args.session_id ?? randomUUID();
  const homeDir = args.home_dir ?? os.homedir();
  const tokenBudgetCap = args.max_tokens_per_task ?? DEFAULT_MAX_TOKENS_PER_TASK;
  const runSubagent = args.runSubagentImpl ?? defaultRunSubagent;

  const manifest = resolveManifest(args.options, homeDir, args.manifest);
  const planner = resolvePlannerAgent(manifest);
  const lockManager = new WriteLockManager();
  const artifactStore = new ArtifactStore({
    sessionId,
    homeDir,
    lockManager,
  });
  const reader: ArtifactStoreReader = artifactStore.reader();

  debugLog("info", "crew", "crew:plan_started", {
    data: {
      goal: args.options.goal,
      crew_name: manifest.name,
      planner_token_budget: tokenBudgetCap,
      session_id: sessionId,
    },
  });

  const tokenBudget = {
    max_input: tokenBudgetCap,
    max_output: Math.max(1_000, Math.floor(tokenBudgetCap / 3)),
  };

  let lastError: ParseError | null = null;
  let totalTokens = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryHint =
      attempt === 1 || !lastError
        ? null
        : `Previous attempt failed: ${lastError.reason} — ${lastError.message}`;
    const prompt = buildPlannerPrompt(args.options.goal, manifest, retryHint);

    const result = await runSubagent({
      agent_def: planner,
      prompt,
      artifact_reader: reader,
      depth: 0,
      parent_agent_id: null,
      write_lock_manager: lockManager,
      session_id: sessionId,
      token_budget: tokenBudget,
    });
    totalTokens += result.tokens_used;

    const parsed = parsePlan(result.summary);
    if (parsed.ok) {
      const phases: CrewPhase[] = parsed.phases.map((p) => ({
        ...p,
        complexity_tier: classifyPhaseComplexity(p),
      }));

      const planArtifact: PlanArtifact = {
        id: randomUUID(),
        kind: "plan",
        author_agent: PLANNER_AGENT_ID,
        phase_id: null,
        created_at: Date.now(),
        supersedes: null,
        payload: {
          phases: phases.map((p) => ({
            id: p.id,
            name: p.name,
            complexity_tier: p.complexity_tier,
          })),
          tasks: phases.flatMap((p) =>
            p.tasks.map((t) => ({
              id: t.id,
              phase_id: t.phase_id,
              assigned_agent: t.assigned_agent,
              depends_on: t.depends_on,
            })),
          ),
          rationale: result.summary.length > 4000
            ? result.summary.slice(0, 4000) + " [truncated]"
            : result.summary,
        },
      };

      const writeResult = artifactStore.write(planArtifact, PLANNER_AGENT_ID);
      if (!writeResult.written) {
        // The planner is the only writer in this run, so this should not
        // happen — but if it does we still report the failure cleanly.
        debugLog("error", "crew", "crew:plan_artifact_write_failed", {
          data: { reason: writeResult.reason, message: writeResult.message },
        });
        return {
          status: "plan_failed",
          session_id: sessionId,
          crew_name: manifest.name,
          goal: args.options.goal,
          error: {
            reason: "schema_invalid",
            message: `PlanArtifact write rejected: ${writeResult.reason} — ${writeResult.message}`,
          },
          attempts: attempt,
        };
      }

      debugLog("info", "crew", "crew:plan_ready", {
        data: {
          plan_artifact_id: planArtifact.id,
          phase_count: phases.length,
          tier_distribution: tierDistribution(phases),
          attempts: attempt,
          tokens_used: totalTokens,
          session_id: sessionId,
        },
      });

      return {
        status: "plan_only",
        session_id: sessionId,
        crew_name: manifest.name,
        goal: args.options.goal,
        phases,
        plan_artifact_id: planArtifact.id,
        tokens_used: totalTokens,
      };
    }

    lastError = parsed.error;
    debugLog("warn", "crew", "crew:plan_failed", {
      data: {
        reason: parsed.error.reason,
        message: parsed.error.message,
        attempt,
        session_id: sessionId,
      },
    });
  }

  // Two attempts exhausted.
  const finalError = lastError!;
  return {
    status: "plan_failed",
    session_id: sessionId,
    crew_name: manifest.name,
    goal: args.options.goal,
    error: finalError,
    attempts: 2,
  };
}

/**
 * Full crew run — planning + phase loop. Returns {@link CrewCompletedResult}
 * on success/halt, or {@link CrewPlanFailedResult} if planning never produced
 * a valid plan after one retry. The runner does NOT throw on phase-level
 * failures; failed/blocked tasks are recorded on the phase and execution
 * advances. Session-budget exhaustion halts the loop and marks the
 * remaining phases blocked.
 *
 * Out of scope (next PR): discussion meeting, drift check, post-mortem,
 * user checkpoint UI.
 */
export async function runCrew(args: RunCrewArgs): Promise<CrewRunResult> {
  const planResult = await runPlanning(args);
  if (planResult.status === "plan_failed") return planResult;

  const sessionId = planResult.session_id;
  const homeDir = args.home_dir ?? os.homedir();
  const workdir = args.workdir ?? args.options.workdir;
  const manifest = args.manifest ?? resolveManifest(args.options, homeDir);
  const executePhaseImpl = args.executePhaseImpl ?? defaultExecutePhase;
  const runDiscussionMeetingImpl =
    args.runDiscussionMeetingImpl ?? defaultRunDiscussionMeeting;
  const runSubagent = args.runSubagentImpl ?? defaultRunSubagent;

  const lockManager = new WriteLockManager();
  // The artifact store replays the JSONL, so it sees the PlanArtifact
  // written during planning.
  const artifactStore = new ArtifactStore({
    sessionId,
    homeDir,
    lockManager,
  });
  const reader: ArtifactStoreReader = artifactStore.reader();

  const knownFiles = new KnownFilesRegistry();
  const doomLoop = new DoomLoopDetector();
  const budgetTracker = new BudgetTracker({
    max_tokens_per_session:
      args.max_tokens_per_session ?? DEFAULT_MAX_TOKENS_PER_SESSION,
    max_tokens_per_phase:
      args.max_tokens_per_phase ?? DEFAULT_MAX_TOKENS_PER_PHASE,
  });

  const phaseSummaryIds: string[] = [];
  let totalTokens = planResult.tokens_used;
  let endedBy: CrewEndedBy = "all_phases_complete";

  for (let i = 0; i < planResult.phases.length; i++) {
    const phase = planResult.phases[i]!;

    if (args.signal?.aborted) {
      endedBy = "abort_signal";
      // Mark remaining phases blocked.
      for (let j = i; j < planResult.phases.length; j++) {
        const p = planResult.phases[j]!;
        for (const t of p.tasks) {
          if (t.status === "pending") {
            t.status = "blocked";
            t.error = "session aborted";
            t.error_kind = "unknown";
          }
        }
      }
      break;
    }

    phase.status = "executing";
    phase.started_at = Date.now();
    debugLog("info", "crew", "phase:start", {
      data: {
        phase_id: phase.id,
        phase_index: i,
        complexity_tier: phase.complexity_tier,
      },
    });

    const phaseTimeBudget =
      args.phase_time_budget_ms_by_tier?.[phase.complexity_tier];

    const phaseResult = await executePhaseImpl({
      phase,
      manifest,
      workdir,
      artifact_reader: reader,
      write_lock_manager: lockManager,
      known_files: knownFiles,
      budget_tracker: budgetTracker,
      session_id: sessionId,
      doom_loop: doomLoop,
      runSubagentImpl: runSubagent,
      signal: args.signal,
      phase_time_budget_ms: phaseTimeBudget,
    });

    phase.completed_at = Date.now();
    phase.status =
      phaseResult.task_count.completed === phaseResult.task_count.total
        ? "completed"
        : "aborted";
    totalTokens += phaseResult.tokens_used;

    // Discussion meeting at the phase boundary (skipped on first/last
    // boundary and Tier-1 phases — runDiscussionMeeting decides).
    const next_phase = planResult.phases[i + 1];
    let meetingNotesArtifactId: string | undefined;
    try {
      const meetingResult = await runDiscussionMeetingImpl({
        prev_phase: phase,
        next_phase,
        manifest,
        goal: planResult.goal,
        artifact_store: artifactStore,
        write_lock_manager: lockManager,
        session_id: sessionId,
        runSubagentImpl: runSubagent,
        signal: args.signal,
      });
      if (meetingResult.skipped_reason === null) {
        meetingNotesArtifactId =
          meetingResult.meeting_notes_artifact_id !== "<write_failed>"
            ? meetingResult.meeting_notes_artifact_id
            : undefined;
        if (meetingNotesArtifactId) {
          phase.artifact_ids = [...phase.artifact_ids, meetingNotesArtifactId];
        }
        // Reflection artifact ids are appended too, so the PhaseSummary
        // index can surface them to the user.
        for (const id of meetingResult.reflection_artifact_ids) {
          phase.artifact_ids = [...phase.artifact_ids, id];
        }
      }
    } catch (err) {
      debugLog("error", "crew", "meeting:exception", {
        data: { phase_id: phase.id },
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Write the PhaseSummaryArtifact. `key_decisions` and
    // `agent_confidences` stay empty until the drift / compaction PR
    // overlays them.
    const summary: PhaseSummaryArtifact = {
      id: randomUUID(),
      kind: "phase_summary",
      author_agent: "runner",
      phase_id: phase.id,
      created_at: Date.now(),
      supersedes: null,
      payload: {
        phase_id: phase.id,
        tasks_completed: phaseResult.task_count.completed,
        tasks_failed: phaseResult.task_count.failed,
        tasks_blocked: phaseResult.task_count.blocked,
        files_created: phaseResult.files_created,
        files_modified: phaseResult.files_modified,
        key_decisions: [],
        agent_confidences: {},
        ...(meetingNotesArtifactId
          ? { meeting_notes_artifact_id: meetingNotesArtifactId }
          : {}),
      },
    };
    const writeResult = artifactStore.write(summary, "runner");
    if (writeResult.written) {
      phaseSummaryIds.push(summary.id);
      phase.artifact_ids = [...phase.artifact_ids, summary.id];
    } else {
      debugLog("error", "crew", "phase:summary_write_failed", {
        data: {
          phase_id: phase.id,
          reason: writeResult.reason,
          message: writeResult.message,
        },
      });
    }

    debugLog("info", "crew", "phase:done", {
      data: {
        phase_id: phase.id,
        phase_index: i,
        ended_by: phaseResult.ended_by,
        task_count: phaseResult.task_count,
        tokens_used: phaseResult.tokens_used,
      },
    });

    if (phaseResult.ended_by === "session_budget") {
      endedBy = "session_budget";
      // Mark remaining phases blocked.
      for (let j = i + 1; j < planResult.phases.length; j++) {
        const p = planResult.phases[j]!;
        for (const t of p.tasks) {
          if (t.status === "pending") {
            t.status = "blocked";
            t.error = "session_budget_exhausted";
            t.error_kind = "unknown";
          }
        }
      }
      break;
    }
    if (phaseResult.ended_by === "abort_signal") {
      endedBy = "abort_signal";
      break;
    }
  }

  const status = endedBy === "all_phases_complete" ? "completed" : "halted";
  debugLog("info", "crew", "crew:done", {
    data: {
      session_id: sessionId,
      status,
      ended_by: endedBy,
      phase_count: planResult.phases.length,
      total_tokens: totalTokens,
      phase_summary_artifact_ids: phaseSummaryIds,
    },
  });

  return {
    status,
    session_id: sessionId,
    crew_name: planResult.crew_name,
    goal: planResult.goal,
    phases: planResult.phases,
    plan_artifact_id: planResult.plan_artifact_id,
    phase_summary_artifact_ids: phaseSummaryIds,
    tokens_used: totalTokens,
    ended_by: endedBy,
  };
}

export class CrewRunner extends EventEmitter {
  async run(options: CrewRunOptions): Promise<CrewRunResult> {
    this.emit("crew:start", {
      goal: options.goal,
      crew_name: options.crew_name,
      workdir: options.workdir,
    });

    const result = await runCrew({ options });

    if (result.status === "plan_failed") {
      this.emit("crew:done", {
        status: "plan_failed",
        session_id: result.session_id,
        error: result.error,
      });
      throw new PlanFailedError(
        `planning failed after ${result.attempts} attempts: ${result.error.reason}`,
        result.attempts,
        result.error,
      );
    }

    this.emit("crew:plan_ready", {
      session_id: result.session_id,
      plan_artifact_id: result.plan_artifact_id,
      phase_count: result.phases.length,
    });
    return result;
  }
}
