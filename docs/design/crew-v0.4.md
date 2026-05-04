# Crew v0.4 Design Specification

**Status**: Draft v2 (patched 2026-05-04)
**Date**: 2026-04-18 (original) · 2026-05-04 (v2 patch)
**Target version**: v0.4.0
**Supersedes**: Sprint mode (rebranded), Collab mode (deprecated)

## 1. Executive summary

OpenPawl v0.4 consolidates the three existing modes (solo/sprint/collab) into two modes: **Solo** and **Crew**. Solo remains as is (single agent with tools). Crew replaces both Sprint and Collab with a unified workplace-inspired multi-agent orchestration that supports hierarchical task decomposition, inter-phase discussion, and human checkpoints.

### Key design commitments

1. **Two-level hierarchy**: Goal decomposes into Phases, Phases contain Tasks. No sub-sub-tasks visible to user. Runtime task expansion allowed internally.
2. **Three-layer checkpoint system**: automated artifact gating (test pass, file exists), visibility gates (phase summary UI), manual user trigger (Escape key, `/pause` command).
3. **Hybrid discussion protocol**: UX layer presents as team meeting (markdown transcript), logic layer uses isolated generation + facilitator synthesis (RA-CR inspired) to prevent sycophancy.
4. **Preset-based crew composition**: Full-stack preset ships with v0.4. User can create custom crews via `~/.openpawl/crews/<name>/` folder structure. Crew size 2-10 agents, recommended 3-5.

### Non-goals

- Deep recursive hierarchies (3+ levels). Research evidence against.
- Free-form agent chat (sycophancy risk).
- Agent self-assignment (forbidden by Planner prompt + runtime guard).
- Per-agent context windows without isolation.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Goal** | User's top-level request. Single string input. |
| **Phase** | Logical chunk of work, contains 1-N Tasks. Has a theme (e.g., "Foundation setup", "API implementation", "Testing"). |
| **Task** | Atomic unit executed by one agent invocation. Has expected output (file creation, edit, shell side-effect). |
| **Sub-task** | Internal task decomposition during execution. Not visible to user. Invoked when Task too large for single agent turn. |
| **Agent** | LLM instance with role-specific prompt + tool access. Defined in crew manifest. |
| **Crew** | Collection of agents assigned to a Goal for its lifecycle. Size 2-10, recommended 3-5. |
| **Facilitator** | Special invocation of Planner agent at phase boundaries for discussion synthesis. |
| **Phase Summary** | Markdown document generated at phase end. Visible to user. |
| **Discussion Meeting** | Formal transition between phases. Explorer agents generate opinions in isolation, Facilitator synthesizes. |
| **Preset** | Named crew definition stored in `~/.openpawl/crews/<name>/`. Reusable across goals. |
| **Artifact** | Typed, append-only output produced by an agent (plan, phase summary, meeting notes, reflection, review, test report, post-mortem, compaction). Persisted to `~/.openpawl/sessions/<id>/artifacts.jsonl`. See §4.6. |
| **Write Lock** | Session-scoped exclusive lock on a file path or artifact stream. Enforces single-writer invariant for `file_write` / `file_edit` / artifact-write tool calls. See §4.4. |

## 3. The four design decisions

### Decision 1: Hierarchical depth

**Choice**: Two levels visible to user (Phase → Task). Internal task expansion allowed during execution but not surfaced.

**Rationale**:
- Matches user mental model ("how many phases, how many tasks per phase")
- Avoids compounding error research anti-pattern (3+ levels)
- Matches successful production patterns (MetaGPT, ChatDev)
- User sees at most ~20 items total (5 phases × 4 tasks) — fits cognitive load

**Contract**:
- Planner outputs JSON with Phases + Tasks on initial decomposition
- No `sub_tasks` field in Phase/Task schema
- `expandTaskRuntime(taskId, reason)` is **mental decomposition inside a single agent invocation** — the agent reasons about subtasks as steps in its chain-of-thought (and as a structured note in its scratchpad). It does NOT spawn additional LLM calls and produces no new agent contexts. The helper exists only to record the decomposition for telemetry and for the post-mortem.
- If the agent genuinely needs another LLM call for a subtask (because it requires a different tool allowlist, fresh context, or cannot fit the work in its remaining turns), it must go through the **subagent path** defined in §5.6 — never through `expandTaskRuntime`.
- Runtime expansion via subagents is depth ≤ 1, no recursion. This mirrors the Anthropic Agent SDK contract: a subagent cannot itself spawn subagents.

### Decision 2: Checkpoint triggers

**Choice**: Three-layer system running in parallel.

**Layer 1 — Automated artifact gating (always on)**:
- After every Task: validator runs (PR #82 logic). Task marked `completed`, `incomplete`, `failed`, or `blocked`.
- After every Phase: all tasks in phase must reach terminal state. No Phase advances until previous complete.
- On repeated failures: classifier runs (PR #77). Env-classified → marked `blocked`, no retry.

**Layer 2 — Visibility gates (user-facing, non-blocking by default)**:
- After every Phase: generate Phase Summary. Display in UI with tasks completed/failed/blocked breakdown, files created/modified (diff link), confidence score from each agent (0-100), key decisions made, discussion meeting notes (next phase's proposed tasks).
- User can `/continue` to advance, `/adjust` to modify plan, or `/abort` to stop
- Default behavior: auto-advance after 30 seconds if user doesn't respond (configurable)

**Layer 3 — Manual pause (always available)**:
- Escape key during any agent turn: graceful interrupt, completes current tool call, returns control
- `/pause` slash command at any time
- `/skip` to force-complete current task
- `/reorder` to change next phase's tasks

**Contract**:
- Layer 1 is deterministic, runs without user intervention
- Layer 2 blocks only if `strict_mode: true` (configurable, default `false` for auto-advance with 30s timeout)
- Layer 3 fires immediately on user input

### Decision 3: Discussion protocol (Hybrid meeting + RA-CR)

**Choice**: User-facing team meeting transcript. Underlying logic uses isolated Explorer generation + Facilitator synthesis.

**Flow at phase boundary**:

1. Each agent in crew generates independent "reflection" in isolated context (what went well, what went poorly, next phase focus, confidence 0-100). Agents do NOT see each other's reflections during generation.

2. Facilitator (Planner role, separate invocation) receives all reflections. Identifies top 2 agreements, top 2 divergent concerns, 1 critical missing perspective. Proposes next phase's tasks.

3. Facilitator writes Meeting Summary in chat-friendly markdown:

```
## Phase {N} retrospective

### What we achieved
- {synthesized agreement point 1}
- {synthesized agreement point 2}

### What we're debating
- {divergent concern 1}
- {divergent concern 2}

### Missing perspective
- {critical gap}

### Proposed next phase
- {tasks with rationale}
```

4. If user approves, next phase starts. If user adjusts, plan updated.

**Protocol rules**:
- Explorer agents must generate in isolation (separate LLM calls, no shared context)
- Facilitator must be a different agent instance from Explorers
- If Explorer reflection contains <3 sentences, reject and re-prompt
- If 2+ Explorers give identical reflections (hash match first 100 chars), flag as sycophancy and re-prompt

**Complexity tiers (meeting frequency)**:

The Planner annotates each phase with a `complexity_tier` field (`"1" | "2" | "3"`). The discussion meeting cost varies by tier:

| Tier | Meeting | Used when |
|---|---|---|
| 1 | Skipped entirely | Low-overhead, simple work — task count ≤ 2, file scope ≤ 2 files, dependency depth = 0 |
| 2 | Lightweight 1-round meeting (reflections only, no divergence/missing-perspective synthesis) | Moderate work — task count 3–5 OR file scope 3–10 OR dep depth 1 |
| 3 | Full 2-round RA-CR style synthesis as described above | Heavy work — task count > 5 OR file scope > 10 OR dep depth ≥ 2 OR cross-cutting concerns |

Heuristic inputs the Planner considers: number of tasks in phase, set of files touched (if forecastable), maximum dependency depth in the phase DAG, and whether the phase touches multiple subsystems. A phase that follows a Tier-3 meeting must run the Tier-3 protocol on the next boundary regardless of its own tier (so divergent concerns from the prior synthesis get re-examined).

### Decision 4: Role composition (preset + custom)

**Choice**: Preset templates (v0.4 ships full-stack only) + user custom via folder-based crew definitions. Crew size 2-10, recommended 3-5 (warning outside).

**Preset storage structure**:

```
~/.openpawl/crews/
  full-stack/           # built-in preset, ship with v0.4
    manifest.yaml
    agents/
      coder.md
      reviewer.md
      planner.md
      tester.md
  my-custom-crew/       # user-created
    manifest.yaml
    agents/
      frontend-coder.md
      backend-coder.md
      devops.md
```

**manifest.yaml format**:

```yaml
name: full-stack
description: Balanced crew for web application development
version: 1.0.0
agents:
  - id: coder
    name: Coder
    description: Writes and edits application code
    prompt_file: agents/coder.md
    tools:
      - file_write
      - file_edit
      - file_read
      - file_list
      - shell_exec
    model: default
  - id: reviewer
    name: Reviewer
    description: Reviews code quality and catches issues
    prompt_file: agents/reviewer.md
    tools:
      - file_read
      - file_list
    model: default
  - id: planner
    name: Planner
    description: Decomposes goals into phases and tasks
    prompt_file: agents/planner.md
    tools:
      - file_read
      - file_list
    model: default
  - id: tester
    name: Tester
    description: Writes tests and verifies behavior
    prompt_file: agents/tester.md
    tools:
      - file_write
      - file_read
      - shell_exec
    write_scopes:
      file_write: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**", "**/tests/**"]
    model: default
constraints:
  min_agents: 2
  max_agents: 10
  recommended_range: [3, 5]
  required_roles: []
```

**Runtime capability gate**:

The capability gate lives in `src/router/llm-agent-runner.ts` (renamed to `src/crew/agent-runner.ts` in §7.2). Before any tool call dispatched on behalf of an agent, the runner checks the calling agent's manifest `tools` list. If the requested tool name is not present, the runner returns a structured `ToolForbidden` error to the agent:

```typescript
{ kind: "ToolForbidden", agent_id: string, tool: string, reason: string }
```

The error is fed back into the agent's tool-result channel (not raised as an exception) so the agent can react — typically by routing the work to the appropriate role via the Planner, or completing the task without the forbidden tool.

`AgentDefinition` gains an optional `write_scopes` field — a map from tool name to an array of glob patterns. When a write-capable tool (`file_write`, `file_edit`) is invoked, the runner intersects the target path against the scope globs; a path outside the scope produces a `ToolForbidden` with `reason: "path outside write_scope"`. Example: tester's `file_write` scoped to `**/*.{test,spec}.{ts,tsx,js,jsx}` (see manifest above).

Reviewer / Tester / Planner / Facilitator never receive `file_edit` in their manifest tool list — they read code and produce review / test / planning artifacts (see §4.6), never edit application code. Tester writes test files only, gated by `write_scopes`. Coder retains both `file_write` and `file_edit` in v0.4; the redundancy is flagged for v0.5 review (one of `file_edit` is likely sufficient).

**CLI commands for preset management**:

```bash
openpawl crew list
openpawl crew show <name>
openpawl crew create <name>
openpawl crew edit <name>
openpawl crew delete <name>
openpawl crew validate <name>
openpawl --crew <name> --goal "..."
```

**TUI slash commands**:

```
/crew                # show current crew composition
/crew switch <name>  # switch to different crew mid-session
/crew add <role>     # add agent from role list
/crew remove <role>  # remove agent
/crew save <name>    # save current composition as new preset
```

### Decision 5: Token economics

**Choice**: Three-level token budget enforced at task / phase / session scope, checked pre-execution.

**Rationale**:
- Multi-agent crews multiply token usage 3–10× over solo runs; without caps a runaway plan can burn through a paid tier in one phase
- Enforcing pre-execution (estimated input + max_completion) catches budget breaches before the LLM call, not after
- Three scopes match the natural failure modes: a single task that explodes, a phase that drifts, and a session that compounds

**Caps** (configurable per crew via manifest, with defaults):

| Cap | Default | Scope |
|---|---|---|
| `max_tokens_per_task` | 50_000 | Per single agent invocation (input + max completion) |
| `max_tokens_per_phase` | 200_000 | Sum across all tasks + meeting in a phase |
| `max_tokens_per_session` | 1_000_000 | Sum across all phases for the goal |

**Pre-execution check**:

Before each LLM call the runner estimates `input_tokens + max_completion_tokens` and compares against all three caps (task, phase-running-total + this call, session-running-total + this call). On breach it returns a structured `BudgetExceeded` error:

```typescript
{
  kind: "BudgetExceeded",
  scope: "task" | "phase" | "session",
  cap: number,
  current: number,
  attempted: number,
}
```

The error pauses execution and surfaces a UI prompt: `[continue with raised cap / abort phase / abort session]`. In headless mode the call exits non-zero with the structured error written to stdout.

**UI surfacing**:

The TUI status bar shows `tokens used / session_budget` continuously. Color thresholds: default below 80% of cap, yellow at 80–95%, red above 95%. The phase summary card also breaks down `tokens by agent` for the just-finished phase.

These token-accounting fields appear in the §4 schemas (`max_tokens_per_task` on `CrewTask`, `max_tokens_per_phase` and rolling `tokens_used` on `CrewPhase`, `max_tokens_per_session` and rolling `session_tokens_used` on `CrewGraphState`).

## 4. Data structures

### 4.1 Crew state annotation

```typescript
// src/crew/types.ts
import { z } from "zod";

export const AgentToolSchema = z.enum([
  "file_read", "file_write", "file_edit", "file_list",
  "shell_exec", "web_search", "web_fetch", "git_ops"
]);
export type AgentTool = z.infer<typeof AgentToolSchema>;

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  prompt: z.string().min(10),
  tools: z.array(AgentToolSchema),
  model: z.string().optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const CrewConstraintsSchema = z.object({
  min_agents: z.number().int().min(2).max(10).default(2),
  max_agents: z.number().int().min(2).max(10).default(10),
  recommended_range: z.tuple([z.number().int(), z.number().int()]).default([3, 5]),
  required_roles: z.array(z.string()).default([]),
});

export const CrewManifestSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  description: z.string().max(500),
  version: z.string().default("1.0.0"),
  agents: z.array(AgentDefinitionSchema).min(2).max(10),
  constraints: CrewConstraintsSchema,
});
export type CrewManifest = z.infer<typeof CrewManifestSchema>;
```

### 4.2 Phase and Task state

```typescript
export const TaskStatusSchema = z.enum([
  "pending", "in_progress", "completed", "incomplete", "failed", "blocked"
]);

export const CrewTaskSchema = z.object({
  id: z.string(),
  phase_id: z.string(),
  description: z.string(),
  assigned_agent: z.string(),
  depends_on: z.array(z.string()).default([]),
  status: TaskStatusSchema.default("pending"),
  tool_calls: z.array(z.unknown()).default([]),
  tool_call_results: z.array(z.unknown()).default([]),
  last_shell_failure: z.unknown().optional(),
  result: z.string().optional(),
  files_created: z.array(z.string()).default([]),
  files_modified: z.array(z.string()).default([]),
  error: z.string().optional(),
  error_kind: z.enum([
    "env_command_not_found", "env_missing_dep", "env_perm",
    "env_port_in_use", "timeout", "agent_logic", "unknown"
  ]).optional(),
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  max_tokens_per_task: z.number().int().positive().default(50_000),
  wall_time_ms: z.number().default(0),
  llm_calls: z.number().default(0),
  retry_count: z.number().default(0),
  confidence: z.number().min(0).max(100).optional(),
});

export const PhaseStatusSchema = z.enum([
  "pending", "planning", "executing", "reviewing", "awaiting_user", "completed", "aborted"
]);

export const CrewPhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: PhaseStatusSchema.default("pending"),
  complexity_tier: z.enum(["1", "2", "3"]).default("2"),
  tasks: z.array(CrewTaskSchema),
  artifact_ids: z.array(z.string()).default([]),
  max_tokens_per_phase: z.number().int().positive().default(200_000),
  tokens_used: z.number().int().nonnegative().default(0),
  started_at: z.number().optional(),
  completed_at: z.number().optional(),
});
```

Note: the previous `summary: string` and `meeting_notes: string` fields are removed. Phase summaries and meeting notes are now typed artifacts referenced through `artifact_ids` — see §4.6.

### 4.3 GraphState extension

```typescript
export const CrewGraphState = z.object({
  goal: z.string(),
  mode: z.enum(["solo", "crew"]),
  crew_manifest: CrewManifestSchema.optional(),
  crew_name: z.string().optional(),
  phases: z.array(CrewPhaseSchema).default([]),
  current_phase_index: z.number().default(0),
  current_meeting: z.object({
    phase_id: z.string(),
    reflections: z.array(z.object({
      agent_id: z.string(),
      went_well: z.array(z.string()),
      went_poorly: z.array(z.string()),
      next_phase_focus: z.array(z.string()),
      confidence: z.number(),
    })).default([]),
    facilitator_synthesis: z.string().optional(),
  }).optional(),
  awaiting_user_action: z.boolean().default(false),
  auto_advance_timer_ms: z.number().default(30000),
  strict_mode: z.boolean().default(false),
  max_tokens_per_session: z.number().int().positive().default(1_000_000),
  session_tokens_used: z.number().int().nonnegative().default(0),
  drift_warn_threshold: z.number().min(0).max(1).default(0.5),
  drift_halt_threshold: z.number().min(0).max(1).default(0.75),
}).passthrough();
```

### 4.4 Write lock manager

**Single-writer invariant**: at any moment, at most one agent in the crew may hold a write lock for a given file path or artifact stream. This mirrors Cognition's May 2026 finding that multi-agent systems collapse without an exclusive-writer rule — concurrent edits to the same file produce silent contradictions that no downstream agent can recover from.

**Lock keys**:
- `file:<absPath>` — taken before any `file_write` or `file_edit` tool call against `absPath`
- `artifact:<sessionId>` — taken before any artifact-write into `~/.openpawl/sessions/<sessionId>/artifacts.jsonl`

**Lock manager API** (lives in `src/crew/lock-manager.ts`):

```typescript
export type LockKey = `file:${string}` | `artifact:${string}`;

export interface LockManager {
  // Returns a release handle on success, or WriteLockDenied if held by another agent.
  acquire(key: LockKey, agent_id: string, timeout_ms?: number):
    Promise<{ release: () => void } | WriteLockDenied>;
  // Inspect current holder without acquiring.
  holder(key: LockKey): string | null;
}

export interface WriteLockDenied {
  kind: "WriteLockDenied";
  key: LockKey;
  held_by: string;        // agent_id of current holder
  requested_by: string;   // agent_id that was denied
  held_since_ms: number;
}
```

**Tool wrapper integration**:

The runner wraps every write-capable tool (`file_write`, `file_edit`, artifact-write helpers) so that the lock is acquired before the inner tool executes and released after — successful path or error path. If `acquire` returns `WriteLockDenied`, the runner returns it as a structured tool result (not an exception). The calling agent receives the denial in its tool-result channel and can react: yield, request the planner to re-route, or wait and retry on a later turn.

Locks are session-scoped (in-process) for v0.4. Cross-session coordination is out of scope until v0.5.

**Role write-permissions**:

Reviewer, Tester (for non-test paths), Planner, and Facilitator agents must NOT have `file_write` or `file_edit` in their manifest tool list at all — they read application code and produce review / test / planning artifacts (see §4.6) via the artifact-write path, never edit application source. The runtime capability gate (§3 Decision 4) is the first line of defense; the lock manager is the second, for the agents that *do* have write tools.

### 4.5 Tool registry

**Lazy tool schema loading**: tool schemas are not injected into the agent system prompt at startup. Each agent boots with a minimal baseline:

- `file_read`
- `file_list`
- `tool_search` — keyword-search over the registry, returns names + one-line descriptions of matching tools

The agent calls `tool_search("<keywords>")` mid-turn when it needs a capability it doesn't yet have. The runner loads the matching tool schemas into the **next message turn's** `tools` array — never back into the system prompt. Reason: the system prompt is the prompt-cache anchor; mutating it invalidates the cache for every subsequent turn. Adding to the per-turn tool list keeps the cached prefix intact.

This follows the Anthropic late-2025 Tool Search Tool pattern. Token target: a session with 5 MCP servers configured adds **< 5K tokens** to the baseline system prompt (vs. ~30–80K if all tool schemas were eagerly injected).

Agents whose role inherently requires write capability (Coder, Tester) ship with `file_write` / `file_edit` already in their manifest tool list — those are not lazy-loaded, since the agent will use them on essentially every turn and the cache cost is amortized.

### 4.6 Artifact store

The free-form `summary: string` and `meeting_notes: string` fields are replaced with a typed, append-only artifact store. Every cross-phase or cross-agent piece of structured output is an artifact.

**Artifact kinds**:

| Kind | Author | Content |
|---|---|---|
| `PlanArtifact` | Planner | Initial decomposition: phases + tasks + complexity_tiers |
| `PhaseSummaryArtifact` | Facilitator | Phase outcome: tasks completed/failed/blocked, files touched, key decisions |
| `MeetingNotesArtifact` | Facilitator | Discussion meeting transcript (RA-CR synthesis output) |
| `ReflectionArtifact` | Any agent | Per-agent retrospective at phase boundary (input to meeting) |
| `ReviewArtifact` | Reviewer | Code review notes against a phase's diff |
| `TestReportArtifact` | Tester | Test run output, pass/fail counts, coverage delta |
| `PostMortemArtifact` | Planner | End-of-session lessons learned |
| `PhaseCompactionArtifact` | Runner | Summary of compacted phase (see §5.7) |

**Common envelope**:

```typescript
export const ArtifactKindSchema = z.enum([
  "plan", "phase_summary", "meeting_notes", "reflection",
  "review", "test_report", "post_mortem", "phase_compaction",
]);

export const ArtifactEnvelopeSchema = z.object({
  id: z.string().uuid(),
  kind: ArtifactKindSchema,
  author_agent: z.string(),       // agent_id, or "runner" for system-authored
  phase_id: z.string().nullable(),
  created_at: z.number(),         // unix ms
  supersedes: z.string().uuid().nullable(),
  payload: z.unknown(),           // refined per kind below
});
```

**Per-kind payload schemas** (sketch — full schemas live in `src/crew/artifacts/schemas.ts`):

```typescript
export const PlanArtifactPayload = z.object({
  phases: z.array(CrewPhaseSchema.pick({ id: true, name: true, complexity_tier: true })),
  tasks: z.array(CrewTaskSchema.pick({ id: true, phase_id: true, assigned_agent: true, depends_on: true })),
  rationale: z.string(),
});

export const PhaseSummaryArtifactPayload = z.object({
  phase_id: z.string(),
  tasks_completed: z.number(),
  tasks_failed: z.number(),
  tasks_blocked: z.number(),
  files_created: z.array(z.string()),
  files_modified: z.array(z.string()),
  key_decisions: z.array(z.string()),
  agent_confidences: z.record(z.string(), z.number()), // agent_id -> 0..100
});

export const MeetingNotesArtifactPayload = z.object({
  phase_id: z.string(),
  achievements: z.array(z.string()),
  divergences: z.array(z.string()),
  missing_perspectives: z.array(z.string()),
  proposed_next_phase_tasks: z.array(z.string()),
  drift_score: z.number().min(0).max(1).optional(), // see §5.5
});

export const ReflectionArtifactPayload = z.object({
  agent_id: z.string(),
  went_well: z.array(z.string()),
  went_poorly: z.array(z.string()),
  next_phase_focus: z.array(z.string()),
  confidence: z.number().min(0).max(100),
});

export const PhaseCompactionArtifactPayload = z.object({
  phase_id: z.string(),
  pre_compaction_tokens: z.number(),
  post_compaction_tokens: z.number(),
  dropped_tool_results: z.number(),
  summary: z.string(),
});
// ReviewArtifact, TestReportArtifact, PostMortemArtifact follow the same pattern.
```

**Persistence**: append-only JSONL at `~/.openpawl/sessions/<sessionId>/artifacts.jsonl`, one envelope per line. Read access is universal across agents in the session (any agent can call `artifactStore.list({ kind, phase_id })` and `artifactStore.get(id)`). Write access goes through `artifactStore.append(envelope)`, which acquires the `artifact:<sessionId>` lock from §4.4 before writing — guaranteeing single-writer semantics on the JSONL.

**Supersession**: an artifact's `supersedes` field points at an older artifact id when a later one replaces it (e.g., a re-planning event produces a new `PlanArtifact` that supersedes the previous). The store never deletes; consumers filter to the latest non-superseded version per `(kind, phase_id)` when displaying.

`CrewPhase.artifact_ids` (§4.2) is the per-phase index into this store.

## 5. Execution flow

### 5.1 Top-level crew orchestration (pseudocode)

```typescript
async function runCrew(goal, crew_manifest, options) {
  const state = createInitialState(goal, crew_manifest, options);
  const known_files = new KnownFilesRegistry();

  emit("crew:start", { goal, crew_name: crew_manifest.name });

  const initial_plan = await runPlanningPhase(state);
  state.phases = initial_plan.phases;

  if (options.confirm_plan !== false) await showPlanConfirmation(state);

  for (let i = 0; i < state.phases.length; i++) {
    state.current_phase_index = i;
    const phase = state.phases[i];

    emit("phase:start", { phase_id: phase.id });
    phase.started_at = Date.now();
    phase.status = "executing";

    await executePhase(phase, state, known_files);

    // Skip discussion meeting on the first phase (no prior phase to retrospect on)
    // and on the last phase (no next phase to plan).
    if (i > 0 && i < state.phases.length - 1) {
      phase.status = "reviewing";
      await runDiscussionMeeting(phase, state);
    }

    phase.summary = generatePhaseSummary(phase, state);
    phase.status = "awaiting_user";
    const user_action = await presentPhaseSummary(phase, state);

    if (user_action === "abort") {
      phase.status = "aborted";
      return { status: "aborted", phases: state.phases };
    }

    if (user_action === "adjust") {
      const adjusted = await runPlanAdjustment(state);
      state.phases = [...state.phases.slice(0, i + 1), ...adjusted];
    }

    phase.status = "completed";
    phase.completed_at = Date.now();
  }

  const lessons = await runCrewPostMortem(state);
  emit("crew:done", { phases: state.phases });
  return { status: "completed", phases: state.phases, lessons };
}
```

### 5.2 Planning phase

Key invariants:
- Planner receives list of available agents from manifest
- Planner prompt explicitly forbids self-assignment
- Runtime guard downgrades any planner self-assignment to coder for write-intent tasks
- Output validated against CrewTaskSchema before accepting

### 5.3 Phase execution with parallelism

- Tasks in phase executed respecting `depends_on` DAG
- Parallel execution when deps met, bounded by `MAX_PARALLEL_TASKS`
- Known files registry updated after each task completes
- Each task gets fresh context + known files block injection

### 5.4 Single task execution

- Build prompt with agent role + task description + known files + prior tasks block
- Invoke agent with bounded tools + max_turns limit
- On tool failures: classifier determines env vs agent_logic
- Env errors → blocked status, no retry
- Agent logic errors → retry up to N times with feedback
- File existence gate validates claimed completions

### 5.5 Discussion meeting

- Gather reflections from each agent in isolation (parallel LLM calls, no shared context). Stored as `ReflectionArtifact` per agent.
- Anti-sycophancy: reject trivial (<3 sentences), detect duplicates via hash
- Facilitator (Planner role, separate instance) synthesizes into a `MeetingNotesArtifact`
- **Drift check**: after the facilitator writes the meeting notes, the runner calls into `src/drift/` to score the meeting notes (achievements + divergences + proposed next-phase tasks) against the original goal. The score is `0..1`, where `0` means perfectly aligned and `1` means fully drifted. The score is written into `MeetingNotesArtifactPayload.drift_score`.
- Two thresholds (configurable via `CrewGraphState.drift_warn_threshold` / `drift_halt_threshold`, defaults `0.5` / `0.75`):
  - `score >= warn`: log a structured warn event, render the score in yellow on the phase summary card. Run continues.
  - `score >= halt`: pause the crew. Surface a re-anchor prompt to the user containing (a) the original goal verbatim, (b) the top 3 drifting decisions extracted from the meeting notes, and (c) options `[continue / abort / edit goal]`. The user's response feeds back into either the next phase plan, an aborted run, or a new goal that re-seeds the planner.
  - Headless mode: warn writes the structured event to debug logs and continues. Halt exits non-zero with the structured drift report on stdout.
- Meeting notes presented to user as chat-readable transcript (rendered from the `MeetingNotesArtifact`).

### 5.6 Subagent invocation contract

When an agent genuinely needs another LLM call for a subtask (Decision 1, §3), it goes through `src/crew/subagent-runner.ts`. This wraps the existing agent runner with strict isolation:

- **Fresh context constructor**: the subagent boots with no inherited message history. The caller provides a single prompt string only — no transcript, no prior tool results.
- **Read-only artifact access**: the subagent receives an `ArtifactStoreReader` (no writer). It cannot write artifacts; if it produces output that needs persisting, the caller persists it after the subagent returns.
- **Tool allowlist from caller**: the caller passes an explicit subset of its own tool list. The subagent's runtime capability gate (§3 Decision 4) enforces this allowlist.
- **Depth counter**: the runner increments a `subagent_depth` counter on entry. If `depth > 1`, the call is rejected with a structured `SubagentDepthExceeded` error before any LLM call. No recursion: a subagent cannot itself spawn subagents.
- **Summary-only return**:

```typescript
export interface SubagentResult {
  summary: string;                      // 1-3 paragraphs, what was done + key findings
  produced_artifacts: ArtifactId[];     // ids the caller should persist (if any)
  tokens_used: number;                  // for budget accounting (§3 Decision 5)
}
```

The caller integrates the `summary` only — never the raw transcript. This mirrors Anthropic's Agent SDK contract: the parent agent's context window grows by ~1KB per subagent call, not by the subagent's full session.

### 5.7 Context compaction

When the running message log for an agent invocation crosses **80% of the model's context window** (configurable via `OPENPAWL_COMPACT_AT`, accepts `0..1` for fraction or absolute token count), the runner runs a compaction pass before the next turn:

1. Identify phases marked `completed` whose tool results sit in the current context.
2. Generate a structured summary covering: phase goal, tasks executed, files touched, key decisions, agent confidences. Persist as a `PhaseCompactionArtifact` (§4.6).
3. Drop the `tool_result` content for those phases from the live message log; **keep the `tool_call` records** so the model retains the structural shape of what happened.
4. Recent context — the in-progress phase plus the most recent completed phase — is preserved verbatim. Compaction never touches the active phase.

Emit a debug event:

```typescript
debugLog("info", "compaction", "context_compacted", {
  phase_ids: string[],
  pre_tokens: number,
  post_tokens: number,
  dropped_tool_results: number,
  artifact_id: string,        // PhaseCompactionArtifact id
});
```

If a later phase needs information from a compacted phase, it reads the `PhaseCompactionArtifact` from the artifact store rather than rehydrating the original tool results.

### 5.8 Cross-phase memory

Each agent receives a **hebbian-memory injection block** alongside the known-files block at task start. The block is sourced from `src/memory/hebbian/` and contains the top-K associations relevant to the current task description (vector + Hebbian-weighted retrieval already implemented in v0.3). Format:

```
## Relevant prior associations
- {file/symbol/decision} ↔ {file/symbol/decision}  (strength: 0.84)
- {…}
```

The block is read-only at injection time. After the task completes, the runner updates Hebbian weights based on which associations actually fired (which retrieved files were read, which decisions were referenced) — same write path as solo mode. Cross-phase continuity comes from this memory, not from sharing transcripts between agents.

## 6. Edge cases & failure modes

### 6.1 Agent-level failures

- Empty/malformed response: retry once with format instruction, then fail
- Doom loop: use existing detector, extend fingerprint to include exit code
- BLOCKED: response from agent: mark task blocked, no retry

### 6.2 Phase-level failures

- All tasks fail/blocked: mark phase completed with warning, block next phase
- Phase exceeds time budget (configurable via crew manifest, default scales with `complexity_tier` — Tier 1: 5 min, Tier 2: 15 min, Tier 3: 30 min): kill in-progress gracefully, mark remaining blocked
- Dependency cycle: reject during plan validation
- Orphan tasks (unmet deps): mark as planner bug, fail phase

### 6.3 Discussion meeting failures

- Sycophancy detected: re-prompt with explicit disagreement instruction
- Low-quality facilitator synthesis: retry once, then fallback template
- All reflections rejected: skip meeting, minimal summary from task statuses

### 6.4 User interaction edge cases

- `/abort` mid-task: SIGTERM current, save partial state, preserve committed files
- `/adjust` creating dep cycle: reject edit, let user re-edit
- Terminal close mid-run: session state persisted every phase boundary, `openpawl resume <id>`
- Auto-advance timer during typing: reset on keystroke

### 6.5 Custom crew edge cases

- No write tools in any agent: warning on load, proceed if user confirms
- Duplicate agent IDs: validation error, reject manifest
- Non-existent tool reference: skip that tool, proceed with warning
- Non-configured model: fallback to default, emit warning

## 7. Migration from Sprint/Collab

### 7.1 Files to delete

- `src/router/collab-dispatch.ts`

> Note: `scripts/testing/benchmark.ts` was edited to solo-only in PR #99 (cleanup). The file stays — no further action needed for v0.4.

### 7.2 Files to rename

```
src/sprint/                  → src/crew/
src/sprint/sprint-runner.ts  → src/crew/crew-runner.ts
src/sprint/types.ts          → src/crew/types.ts
src/sprint/error-classify.ts → src/crew/error-classify.ts
src/sprint/post-mortem.ts    → src/crew/post-mortem.ts
src/sprint/task-parser.ts    → src/crew/plan-parser.ts
src/sprint/__tests__/        → src/crew/__tests__/
```

### 7.3 Concepts to rename

| Old | New |
|---|---|
| `SprintRunner` | `CrewRunner` |
| `sprint:start` event | `crew:start` event |
| `sprint:task_retry` event | `crew:task_retry` event |
| `SprintState` type | `CrewGraphState` type |
| `SprintTask` type | `CrewTask` type |
| `--mode sprint` CLI flag | `--mode crew` CLI flag |
| Event source tags `sprint:*` | `crew:*` |

### 7.4 Backward compatibility

v0.4:
- `--mode sprint` accepted with deprecation warning
- `--mode collab` rejected with error
- Old session files load but show "legacy" banner

v0.5:
- Remove `--mode sprint` shim entirely

### 7.5 Config migration

Auto-migrate on first v0.4 run. Backup to `~/.openpawl/config.v0.3.bak.json` first.

Old:
```json
{ "default_mode": "sprint", "sprint_template": "full-stack" }
```

New:
```json
{ "default_mode": "crew", "crew_name": "full-stack", "_migrated_from": "v0.3" }
```

### 7.6 What to preserve from v0.3

Keep unchanged:
- `error-classify.ts` (PR #77)
- Validator strictness (PR #82)
- Planner downgrade guard (PR #83)
- Known files registry (PR #84)
- Source tagging (PR #81, rename tags)
- Debug logger structure
- Structured tool results (PR #76)

Keep but extend:
- `taskExpectsWrite`, `taskDidWrite` (extend for phase-level)
- Retry logic (properly add blocked status)
- Doom loop detector (generalize fingerprint)

Remove entirely:
- Collab sequential chain
- 3-mode UI
- Collab-specific prompts

## 8. Implementation ordering (2-week sprint)

### Week 1: Foundation

- **Day 1-2**: Rename src/sprint/ → src/crew/, delete collab, CLI deprecation
- **Day 3**: Crew manifest system + full-stack preset
- **Day 4-5**: Two-level planning (phases + tasks)

### Week 1: Execution

- **Day 6-7**: Phase execution + dependencies + parallelism
- **Day 8**: Blocked task status (deferred from v0.3)

### Week 2: Meeting + checkpoints

- **Day 9-10**: Discussion meeting with hybrid protocol
- **Day 11-12**: Three-layer checkpoint system

### Week 2: Polish

- **Day 13**: Crew CLI + TUI slash commands
- **Day 14**: Migration shims + docs + CHANGELOG + v0.4.0 release

### Parking lot (v0.5+)

- Additional presets (data-science, content-creation)
- Anti-lazy gates
- Change Ledger
- Auto Research Loop
- Doom loop detector generalization
- FILE_PATH_REGEX fix
- `/mode` picker UX

## 9. Open questions (non-blocking)

> §9.1 (meeting frequency) was promoted into Decision 3 — see complexity tiers.
> §9.4 (token budget enforcement) was promoted into Decision 5.
> §9.5 (cross-phase memory) was promoted into §5.8 — Hebbian memory injection.

1. Facilitator fallback when no planner agent in crew?
2. Confidence score calibration (LLM self-report reliability)?
3. Dynamic crew composition mid-run (defer to v0.6)?
4. Project-specific crew overrides (`./openpawl/crews/`)?

## 10. Changelog

### Draft v2 — 2026-05-04

Patches the v0.4 spec to close gaps identified by the OpenPawl research findings (single-writer multi-agent architecture, capability isolation, drift, lazy tool loading, typed artifacts, token budgets, complexity-tiered meetings, compaction). No code changes — docs-only patch ahead of implementation.

1. **§4.4 Write Lock Manager** — session-scoped single-writer locks on `file:<path>` and `artifact:<sessionId>`; `WriteLockDenied` structured error; reviewer/tester/planner/facilitator no-write rule.
2. **§3 Decision 4 Runtime capability gate** — pre-tool manifest check returns `ToolForbidden`; `write_scopes` glob field on `AgentDefinition`; tester scoped to test paths; coder `file_edit` flagged for v0.5 review.
3. **§3 Decision 1 + §5.6 Subagent contract** — `expandTaskRuntime` is in-context mental decomposition only; real LLM-call subtasks go through a depth-≤1 fresh-context subagent runner returning summary only.
4. **§3 Decision 5 Token economics** — per-task / per-phase / per-session caps with pre-execution `BudgetExceeded` check; status-bar token display; promoted from §9.4.
5. **§3 Decision 3 Complexity-tiered meetings** — Planner annotates each phase with `complexity_tier` (1/2/3); meeting cost scales accordingly; promoted from §9.1.
6. **§4.5 Tool registry / lazy schema loading** — baseline tools `file_read` + `file_list` + `tool_search`; additional tools loaded into next-turn `tools` array (not system prompt) to preserve cache; <5K tokens overhead for 5 MCP servers.
7. **§5.5 Drift integration** — drift score 0..1 written into meeting notes; `drift_warn_threshold` (0.5) logs/UI-yellows, `drift_halt_threshold` (0.75) pauses with re-anchor prompt.
8. **§5.7 Context compaction** — at 80% of model window (`OPENPAWL_COMPACT_AT`), summarize completed phases into `PhaseCompactionArtifact`, drop `tool_result` content (keep `tool_call` records), emit `context_compacted` event.
9. **§4.6 Typed artifact store** — `PlanArtifact`, `PhaseSummaryArtifact`, `MeetingNotesArtifact`, `ReflectionArtifact`, `ReviewArtifact`, `TestReportArtifact`, `PostMortemArtifact`, `PhaseCompactionArtifact`; persisted to `artifacts.jsonl` under single-writer lock; replaces free-form `summary` / `meeting_notes` fields.

**Small fixes**:
- §7.1 — `scripts/testing/benchmark.ts` retained (was edited to solo-only in PR #99, not deleted).
- §5.1 — discussion meeting now skipped on the *first* phase as well as the last.
- §6.2 — phase time budget scales with complexity tier (5/15/30 min) instead of fixed 15 min.
- §9 — promoted §9.1, §9.4, §9.5 out of open questions; renumbered remainders.
- §2 — added "Artifact" and "Write Lock" terminology entries.
- §5.8 — new "Cross-phase memory" subsection wires `src/memory/hebbian/` into the per-task injection block.
