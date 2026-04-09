# Sprint Mode Design

## Context

OpenPawl has two modes: interactive chat (working) and autonomous sprint (original TeamClaw vision). The original 12-node LangGraph pipeline exists but is over-engineered for current needs. This spec covers:

1. **Branch 1 — Dead code audit**: Aggressively remove the unused TeamClaw pipeline code
2. **Branch 2 — SprintRunner**: Build a lightweight autonomous sprint mode that reuses the existing agent registry, tool system, and LLM engine

## Branch 1: Dead Code Audit & Deletion

### Goal

Remove all code from the original TeamClaw LangGraph pipeline that is not imported by any live code path. Live code paths: TUI (`src/app/`), session (`src/session/`), providers (`src/providers/`), engine (`src/engine/`), tools (`src/tools/`), memory (`src/memory/`), context (`src/context/`), router (`src/router/`), streaming (`src/streaming/`), TUI components (`src/tui/`).

### Audit Method

1. Run import analysis across `src/` (excluding `node_modules` and `tests`)
2. For each file, trace whether it is transitively imported by any entry point (`src/cli.ts`, `src/app/index.ts`)
3. Files with zero live imports are candidates for deletion

### Likely Deletions

- `src/core/simulation.ts` — 12-node LangGraph graph definition
- `src/core/graph-state.ts` — GameStateAnnotation (LangGraph state schema)
- `src/graph/` — all node wrappers (confidence-router, preview, etc.)
- `src/work-runner.ts` — multi-run orchestration loop
- `src/agents/coordinator.ts` — LangGraph coordinator node
- `src/agents/planning.ts` — sprint planning node
- `src/agents/system-design.ts` — system design node
- `src/agents/rfc.ts` — RFC documentation node
- `src/agents/worker-bot.ts` — worker task dispatch
- `src/agents/analyst.ts` — post-mortem analysis
- `src/agents/memory-retrieval.ts` — vector memory retrieval node
- `src/agents/composition/` — autonomous team composition
- `src/streaming/agent-runner.ts` — old agent runner
- `src/streaming/stream-orchestrator.ts` — old stream orchestrator
- `src/app/commands/work.ts` — `/work` command (replaced by `/sprint`)
- `/work` command registration in `src/app/index.ts`
- `src/core/worker-events.ts` — event bus for old work pipeline (if orphaned)
- Any other orphaned modules discovered during audit

### What to Keep

- `src/router/agent-registry.ts` — agent definitions (coder, planner, reviewer, etc.)
- `src/engine/llm.ts` — LLM calling with native tool support
- `src/providers/` — provider management
- `src/tools/` — tool definitions and execution
- `src/memory/` — vector memory, hebbian learning
- `src/session/` — session management
- `src/context/` — context tracking and compaction
- `src/tui/` — TUI components
- `src/app/` — app entry point (minus dead commands)
- `src/streaming/tool-call-handler.ts` — tool call token filtering (used by TUI)

### Verification

After deletion:
1. `bun run typecheck` — no new errors
2. `bun run test` — all tests pass (delete orphaned test files too)
3. `bun run build` — builds successfully
4. Manual: TUI launches and chat mode works normally

---

## Branch 2: SprintRunner Implementation

### Architecture

```
/sprint <goal>
  -> SprintRunner.run(goal)
      -> Phase 1: Plan (planner agent generates task list)
      -> Phase 2: Execute (sequential loop: assign -> execute -> review)
      -> Phase 3: Summary
  -> SprintEvents -> TUI renders agent outputs inline
```

SprintRunner is a lightweight orchestrator that:
- Uses `AgentRegistry` to resolve agents (same as chat mode)
- Uses `callLLMMultiTurn` for agent execution (same LLM engine)
- Emits events for TUI integration (same pattern as router events)
- Supports pause/resume via AbortController
- Runs tasks sequentially (v1; parallel deferred to v2)

### Files to Create

#### `src/sprint/types.ts`

```typescript
export interface SprintTask {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  assignedAgent?: string;
  result?: string;
  error?: string;
}

export type SprintPhase = "planning" | "executing" | "paused" | "done" | "stopped";

export interface SprintState {
  goal: string;
  tasks: SprintTask[];
  currentTaskIndex: number;
  phase: SprintPhase;
  startedAt: string;
  completedTasks: number;
  failedTasks: number;
}

export interface SprintResult {
  goal: string;
  tasks: SprintTask[];
  completedTasks: number;
  failedTasks: number;
  duration: number;
}

export interface SprintOptions {
  /** Max tasks the planner should generate. Default: 10. */
  maxTasks?: number;
}

export interface SprintEvents {
  "sprint:start": (data: { goal: string }) => void;
  "sprint:plan": (data: { tasks: SprintTask[] }) => void;
  "sprint:task:start": (data: { task: SprintTask; agentName: string }) => void;
  "sprint:task:complete": (data: { task: SprintTask }) => void;
  "sprint:agent:token": (data: { agentName: string; token: string }) => void;
  "sprint:agent:tool": (data: {
    agentName: string;
    toolName: string;
    status: string;
    details?: { executionId?: string; inputSummary?: string; duration?: number; outputSummary?: string; success?: boolean };
  }) => void;
  "sprint:done": (data: { result: SprintResult }) => void;
  "sprint:error": (data: { error: Error; task?: SprintTask }) => void;
  "sprint:paused": () => void;
  "sprint:resumed": () => void;
}
```

#### `src/sprint/task-parser.ts`

Extracts structured tasks from planner's natural language output.

**Strategy:**
1. Try to parse a JSON array from the response (fenced code block or raw)
2. Fallback: parse numbered list (`1. Description`, `2. Description`, ...)
3. Each task gets a unique ID (`task-1`, `task-2`, ...) and starts as `pending`

```typescript
export function parseTasks(plannerOutput: string): SprintTask[]
```

#### `src/sprint/sprint-runner.ts`

Core orchestrator class.

```typescript
export class SprintRunner extends TypedEventEmitter<SprintEvents> {
  private state: SprintState;
  private abortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;

  constructor(
    private agents: AgentRegistry,
    private providerManager: ProviderManager,
  ) {}

  async run(goal: string, options?: SprintOptions): Promise<SprintResult> {
    this.abortController = new AbortController();
    this.state = { goal, tasks: [], currentTaskIndex: 0, phase: "planning", ... };
    this.emit("sprint:start", { goal });

    // Phase 1: Planning
    const plan = await this.runAgent("planner", {
      prompt: buildPlannerPrompt(goal, options?.maxTasks ?? 10),
      signal: this.abortController.signal,
    });
    this.state.tasks = parseTasks(plan);
    this.state.phase = "executing";
    this.emit("sprint:plan", { tasks: this.state.tasks });

    // Phase 2: Sequential execution
    for (let i = 0; i < this.state.tasks.length; i++) {
      await this.checkPaused();
      if (this.abortController.signal.aborted) break;

      const task = this.state.tasks[i];
      this.state.currentTaskIndex = i;

      // Determine agent assignment (coordinator decides or heuristic)
      const agentName = await this.assignAgent(task);
      task.assignedAgent = agentName;
      task.status = "in_progress";
      this.emit("sprint:task:start", { task, agentName });

      try {
        const result = await this.runAgent(agentName, {
          prompt: buildTaskPrompt(task, this.state),
          signal: this.abortController.signal,
        });
        task.result = result;
        task.status = "completed";
        this.state.completedTasks++;
      } catch (err) {
        task.status = "failed";
        task.error = err.message;
        this.state.failedTasks++;
      }
      this.emit("sprint:task:complete", { task });
    }

    // Phase 3: Done
    this.state.phase = "done";
    const result = { goal, tasks: this.state.tasks, ... };
    this.emit("sprint:done", { result });
    return result;
  }

  pause(): void { /* set paused flag, emit sprint:paused */ }
  resume(): void { /* resolve pause promise, emit sprint:resumed */ }
  stop(): void { /* abort controller, set phase to stopped */ }
  getState(): SprintState { return this.state; }

  private async runAgent(agentName: string, opts: { prompt: string; signal: AbortSignal }): Promise<string> {
    // 1. Get agent definition from registry
    // 2. Call callLLMMultiTurn with agent's system prompt, tools, and task prompt
    // 3. Stream tokens via sprint:agent:token events
    // 4. Stream tool calls via sprint:agent:tool events
    // 5. Return final response text
  }

  private async assignAgent(task: SprintTask): Promise<string> {
    // Simple heuristic: ask coordinator agent to pick
    // Or pattern match: "test" -> tester, "review" -> reviewer, default -> coder
  }

  private async checkPaused(): Promise<void> {
    if (this.paused) {
      await new Promise<void>(resolve => { this.pauseResolve = resolve; });
    }
  }
}
```

#### `src/app/commands/sprint.ts`

Slash command with subcommands:

- `/sprint <goal>` — create SprintRunner, call `run(goal)`, wire events to TUI
- `/sprint stop` — call `runner.stop()`, show summary
- `/sprint status` — show current state (phase, task progress)
- `/sprint plan` — show task list with statuses

```typescript
export function createSprintCommand(deps: SprintCommandDeps): SlashCommand
```

### TUI Integration

Sprint events are wired in the `/sprint` command handler (not in `app/index.ts` globally). Pattern matches the existing `/work` command but with richer output:

| Event | TUI Action |
|-------|-----------|
| `sprint:start` | System message: "Sprint Started: {goal}" |
| `sprint:plan` | System message: numbered task list |
| `sprint:task:start` | Agent message header: "Coder (task 1: ...)" with thinking indicator |
| `sprint:agent:token` | `appendToLast()` — same as chat streaming |
| `sprint:agent:tool` | Tool call views — same as chat |
| `sprint:task:complete` | System message: "Task 1 complete" or "Task 1 failed: ..." |
| `sprint:done` | Panel: summary with stats |
| `sprint:paused` | System message: "Sprint paused. /sprint resume to continue." |

### Pause/Resume Mechanism

- `/sprint` command captures `Ctrl+C` via TUI's abort handler during sprint execution
- `Ctrl+C` once → `runner.pause()` → user returns to chat mode
- `/sprint resume` → `runner.resume()` → continues from next pending task
- `/sprint stop` → `runner.stop()` → terminates, shows summary
- Sprint state is held in memory on the command closure (not persisted to session for v1)

### Agent Assignment Strategy (v1)

Simple keyword heuristic in `assignAgent()`:
- Task contains "test" / "spec" / "verify" → `tester`
- Task contains "review" / "check" / "audit" → `reviewer`
- Task contains "research" / "investigate" / "find" → `researcher`
- Task contains "debug" / "fix" / "bug" → `debugger`
- Task contains "plan" / "design" / "architect" → `planner`
- Default → `coder`

This avoids an extra LLM call per task. Can be upgraded to coordinator-based assignment in v2.

### Testing

Tests in `tests/sprint/`:

- `task-parser.test.ts` — parse JSON tasks, parse numbered lists, handle malformed input
- `sprint-runner.test.ts` — run 3 tasks sequentially, handle task failure, pause/resume, stop mid-sprint
- Event emission order verification

### Verification

1. `bun run typecheck` — no errors
2. `bun run lint` — no errors
3. `bun run test` — all tests pass
4. Manual: `/sprint add user authentication` → watch agents plan and execute
5. Manual: `Ctrl+C` during sprint → pause, `/sprint resume` → continues
6. Manual: `/sprint status` → shows progress
