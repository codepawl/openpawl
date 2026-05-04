# Crew v0.4 Design Specification

**Status**: Draft for review
**Date**: 2026-04-18
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
- If an agent during execution decides a task is too large, it can internally call a helper function `expandTaskRuntime(taskId, reason)` that spawns child tasks **within the same agent invocation** — these do not appear in UI
- Runtime expansion limited to 1 additional level (Task → internal Sub-tasks, no Sub-sub-tasks)

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
      - file_edit
      - file_read
      - shell_exec
    model: default
constraints:
  min_agents: 2
  max_agents: 10
  recommended_range: [3, 5]
  required_roles: []
```

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
  tasks: z.array(CrewTaskSchema),
  summary: z.string().optional(),
  meeting_notes: z.string().optional(),
  started_at: z.number().optional(),
  completed_at: z.number().optional(),
});
```

### 4.3 Capability gate

Per Decision 4, every tool call from a crew agent flows through a runtime
gate before reaching the executor. The gate is the only enforcement
boundary for write capability — agent prompts can lie, the gate can't be
talked around.

Two checks, in order:

1. **Tool allowlist.** `tool_name` must appear in the agent's
   `tools: AgentTool[]`. Any tool outside the list is rejected.
2. **Write-scope glob.** For `file_write` and `file_edit` only, when the
   agent's `write_scope: string[]` is set, `tool_args.path` must match
   at least one glob in the list. Globs are evaluated by minimatch with
   `dot: true` so `__tests__/` paths match. An agent with write tools
   but no `write_scope` defaults to a broad allow.

Rejections produce a structured `ToolForbidden`:

```typescript
export interface ToolForbidden {
  agent_id: string;
  tool: string;
  reason: "tool_not_in_allowlist" | "write_outside_scope";
  message: string;
  /** Set for write_outside_scope. */
  attempted_path?: string;
  /** Set for write_outside_scope. */
  scope?: string[];
}
```

The subagent runner relays a denial back to the LLM as a tool result so
the agent can recover (try a different file, escalate, give up) rather
than crashing the turn. Repeated denials count toward the doom-loop
detector's fingerprint.

### 4.4 Write Lock Manager

Crew agents run in parallel within a phase; without serialization, two
agents can race on the same file or two writers can interleave artifacts.
The Write Lock Manager guarantees one-writer-at-a-time per resource.

```typescript
export class WriteLockManager {
  acquire(key: string, agentId: string, timeoutMs?: number): Promise<void>;
  tryAcquire(key: string, agentId: string): WriteLockResult;
  release(key: string, agentId: string): void;
  releaseAllFor(agentId: string): string[];
  isHeld(key: string): boolean;
  holderOf(key: string): string | null;
  queueDepth(key: string): number;
}
```

Lock-key conventions:

- `file:<absPath>` — guards a single file from concurrent writers.
- `artifact:<sessionId>` — serializes ArtifactStore writes for a session.

Semantics:

- `acquire` blocks until the lock is granted or `timeoutMs` (default 30s)
  elapses, in which case it rejects with `WriteLockTimeoutError`.
- `tryAcquire` never blocks. It returns `{ granted: true }` or
  `{ granted: false, holder_agent, queued_count }`.
- `release` must come from the current holder. Lock is handed off to the
  head of the wait queue; if the queue is empty, the lock entry is
  dropped.
- Same-agent re-acquire of a held key is a reentrant no-op. A single
  matching `release` returns the lock to the next waiter.
- The subagent runner calls `releaseAllFor(agentId)` at turn end to
  guarantee no leaked locks even on early returns or thrown errors.

Debug events: `write_lock_acquired`, `write_lock_released`,
`write_lock_denied`, `write_lock_queued`, `write_lock_timeout`.

### 4.5 Crew GraphState extension

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
}).passthrough();
```

### 4.6 Typed Artifact Store

Cross-phase data lives in a typed, append-only artifact store. The store
is the single durable record of what each phase produced — phase
summaries, reviews, test reports, meeting notes — and is what survives
between sessions, what compaction rolls up, and what the next phase
reads to know what already happened.

**Common envelope** (every artifact, regardless of kind):

```typescript
{
  id: string;            // unique within session
  kind: ArtifactKind;    // discriminator (see below)
  author_agent: string;  // agent_id that produced it
  phase_id: string | null;
  created_at: number;    // epoch ms
  supersedes: string | null;  // older artifact replaced by this one
  payload: KindSpecificPayload;
}
```

**Eight kinds**, each with its own Zod payload schema:

| kind | producer | typical contents |
|---|---|---|
| `plan` | planner (§5.2) | goal, phases (id/name/description/task_ids), rationale |
| `phase_summary` | runner (§5.4) | phase status, achievements, blockers, files touched, task counts, summary text |
| `meeting_notes` | facilitator (§5.5) | phase_id, achievements, debating, missing perspective, proposed next phase, refs to reflection ids |
| `reflection` | each agent (§5.5) | phase_id, agent_id, went_well, went_poorly, next_phase_focus, confidence |
| `review` | reviewer | target files, findings (severity / file / line / message / suggestion), verdict, summary |
| `test_report` | tester | command, exit_code, passed/failed/skipped, failures, stdout/stderr excerpts |
| `post_mortem` | end-of-crew | goal, phases_completed, outcome, lessons (title/detail/category), recommended_followups |
| `phase_compaction` | compactor | source_phase_id, source_artifact_ids, compressed_summary, retained_facts, token deltas |

**Access model:**

- Reads are universal — agents and orchestrator alike receive an
  `ArtifactStoreReader` that exposes only `read(id)` and
  `list({ kind?, phase_id? })`.
- Writes are gated by the Write Lock Manager on
  `artifact:<sessionId>`. The store uses `tryAcquire`, so a write that
  collides with another writer returns
  `{ written: false, reason: "lock_denied", holder_agent, queued_count }`
  rather than blocking. The orchestrator chooses whether to retry,
  back off, or queue elsewhere.
- Other rejection reasons: `validation_failed` (Zod), `duplicate_id`,
  `no_such_predecessor` (for `supersede`).

**Persistence:** append-only JSONL at
`~/.openpawl/sessions/<sessionId>/artifacts.jsonl`. On store construction
the file is replayed line-by-line; malformed lines are debug-logged and
skipped so a partially flushed line cannot block startup. Supersession
chains are reconstructable from the file; old artifacts are not deleted.

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

    if (i < state.phases.length - 1) {
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

- Gather reflections from each agent in isolation (parallel LLM calls, no shared context)
- Anti-sycophancy: reject trivial (<3 sentences), detect duplicates via hash
- Facilitator (Planner role, separate instance) synthesizes into markdown meeting notes
- Meeting notes presented to user as chat-readable transcript

### 5.6 Subagent invocation contract

Every crew agent invocation flows through `runSubagent`. There is no
direct path from the orchestrator to an LLM call for a crew agent. This
is what guarantees the Decision 1 depth limit and the Decision 4
capability gate hold uniformly.

```typescript
export async function runSubagent(args: {
  agent_def: AgentDefinition;
  prompt: string;
  artifact_reader: ArtifactStoreReader;
  depth: number;
  parent_agent_id: string | null;
  token_budget: { max_input: number; max_output: number };
  write_lock_manager: WriteLockManager;
  session_id: string;
  // … injected hooks: executeTool, contextTracker, signal, …
}): Promise<SubagentResult>;

export interface SubagentResult {
  agent_id: string;
  summary: string;
  produced_artifacts: ArtifactId[];
  tokens_used: { input: number; output: number };
  errors: SubagentError[];
}
```

**Invariants:**

- **Fresh history.** No parent transcript leaks into the subagent's
  message list. The system prompt is `agent_def.prompt` plus a generated
  capabilities block plus `you are agent <id> at depth <n>; do not spawn
  further subagents`.
- **Depth limit.** `depth > 1` is rejected immediately with
  `SubagentDepthExceeded`. The crew is hierarchical with at most one
  level of nesting (Decision 1).
- **Reader-only artifact view.** Agent code receives an
  `ArtifactStoreReader` reference. The full `ArtifactStore` writer never
  crosses the subagent boundary, so an agent cannot bypass the
  write-lock by holding a writer reference.
- **Tool gating.** Every tool call is filtered through the capability
  gate (§4.3) before execution. Denials are returned to the LLM as tool
  results so the agent can recover.
- **Write-lock acquire / release.** Writes that need a lock acquire it
  before execution and release it after. The runner calls
  `releaseAllFor(agentId)` at turn end to drain leaked locks even on
  thrown errors or early returns.
- **Token budget.** Per-task cap (default 50k input + 16k output).
  Pre-execution input estimate vs cap rejects with `BudgetExceeded`
  rather than wasting an LLM call. Per-phase and per-session caps stack
  on top (defined in §3 Decision 2 / §6.2).
- **Caller integrates summary only.** The orchestrator reads
  `summary` and `produced_artifacts` — never the raw transcript. This
  is what keeps cross-phase context bounded.

Debug events: `subagent_spawned` (caller, callee, depth, tools,
budget), `subagent_returned` (tokens_used, artifact count, error
count), `subagent_depth_exceeded`, `subagent_budget_exceeded`.

## 6. Edge cases & failure modes

### 6.1 Agent-level failures

- Empty/malformed response: retry once with format instruction, then fail
- Doom loop: use existing detector, extend fingerprint to include exit code
- BLOCKED: response from agent: mark task blocked, no retry

### 6.2 Phase-level failures

- All tasks fail/blocked: mark phase completed with warning, block next phase
- Phase exceeds time budget (15 min default): kill in-progress gracefully, mark remaining blocked
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
- `scripts/testing/benchmark.ts` sprint-specific paths (rename)

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

1. Meeting frequency: every phase vs configurable?
2. Facilitator fallback when no planner agent in crew?
3. Confidence score calibration (LLM self-report reliability)?
4. Token budget enforcement (per-phase cap)?
5. Agent memory across phases (beyond known files)?
6. Dynamic crew composition mid-run (defer to v0.6)?
7. Project-specific crew overrides (`./openpawl/crews/`)?
