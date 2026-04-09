# Sprint Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add autonomous sprint mode to OpenPawl TUI — a lightweight orchestrator that plans tasks from a goal and executes them sequentially using existing agents.

**Architecture:** Two branches. Branch 1 deletes dead TeamClaw pipeline code. Branch 2 builds a new `SprintRunner` class that reuses `AgentRegistry` + `callLLMMultiTurn` + `ToolRegistry` to plan and execute tasks, emitting events to the TUI for live rendering.

**Tech Stack:** TypeScript (ESM), Node.js EventEmitter, existing `callLLMMultiTurn` engine, existing `AgentRegistry`, existing `ToolRegistry`/`ToolExecutor`.

---

## Branch 1: Dead Code Deletion

> Create branch `chore/dead-code-audit` off `staging`.

### Task 1: Audit imports and identify dead files

**Files:**
- Read: all `src/**/*.ts` files

- [ ] **Step 1: Run import analysis**

Run:
```bash
# Find all files imported from src/ (excluding tests and node_modules)
grep -rn "from ['\"]" src/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts" | grep -v "tests/" | sed "s/.*from ['\"]//;s/['\"].*//" | sort -u > /tmp/all-imports.txt

# List all ts files in src/
find src/ -name "*.ts" -not -path "*/node_modules/*" -not -name "*.test.ts" | sort > /tmp/all-files.txt

cat /tmp/all-imports.txt
```

- [ ] **Step 2: Trace entry points**

The two entry points are `src/cli.ts` and `src/app/index.ts`. Trace transitive imports from each to build the set of "live" files. Any `.ts` file in `src/` not transitively reachable from either entry point is dead code.

Run:
```bash
# Quick check: which of the likely-dead files are imported anywhere in live code?
for f in src/core/simulation.ts src/core/graph-state.ts src/work-runner.ts src/agents/coordinator.ts src/agents/planning.ts src/agents/system-design.ts src/agents/rfc.ts src/agents/worker-bot.ts src/agents/analyst.ts src/agents/memory-retrieval.ts src/streaming/agent-runner.ts src/streaming/stream-orchestrator.ts src/app/commands/work.ts src/core/worker-events.ts; do
  base=$(basename "$f" .ts)
  count=$(grep -rn "$base" src/ --include="*.ts" -l | grep -v node_modules | grep -v ".test.ts" | grep -v "$f" | wc -l)
  echo "$count imports: $f"
done
```

- [ ] **Step 3: Record findings**

Document which files are dead (0 live imports) vs alive. Record line counts for each dead file with `wc -l`.

### Task 2: Delete dead pipeline files

**Files:**
- Delete: all files identified as dead in Task 1

- [ ] **Step 1: Delete dead agent files**

```bash
# Delete only if confirmed dead in Task 1. Adjust list based on audit results.
git rm src/agents/coordinator.ts
git rm src/agents/planning.ts
git rm src/agents/system-design.ts
git rm src/agents/rfc.ts
git rm src/agents/worker-bot.ts
git rm src/agents/analyst.ts
git rm src/agents/memory-retrieval.ts
git rm -r src/agents/composition/
```

- [ ] **Step 2: Delete dead core/graph files**

```bash
git rm src/core/simulation.ts
git rm src/core/graph-state.ts
git rm src/core/worker-events.ts
git rm -r src/graph/
```

- [ ] **Step 3: Delete dead orchestration files**

```bash
git rm src/work-runner.ts
git rm src/streaming/agent-runner.ts
git rm src/streaming/stream-orchestrator.ts
git rm src/app/commands/work.ts
```

- [ ] **Step 4: Remove `/work` command registration from app/index.ts**

Search `src/app/index.ts` for any import or registration of the work command and remove it. Also remove the `workerEvents` import if it exists.

```bash
grep -n "work" src/app/index.ts | head -20
```

Remove any matching lines that reference the deleted files.

- [ ] **Step 5: Delete orphaned test files**

```bash
# Find test files that import deleted modules
grep -rn "import.*from.*simulation\|import.*from.*work-runner\|import.*from.*coordinator\|import.*from.*graph-state\|import.*from.*worker-bot\|import.*from.*analyst\|import.*from.*planning" tests/ --include="*.ts" -l 2>/dev/null
```

Delete any test files that only test deleted code.

### Task 3: Fix broken imports and verify

**Files:**
- Modify: any files that imported deleted modules

- [ ] **Step 1: Find broken imports**

Run:
```bash
bun run typecheck 2>&1 | head -50
```

- [ ] **Step 2: Fix each broken import**

For each error, either:
- Remove the import and any code that uses it (if it was only used for the deleted pipeline)
- Or find an alternative (unlikely — deleted code should be fully dead)

- [ ] **Step 3: Run full verification**

Run:
```bash
bun run typecheck && bun run lint && bun run test
```

Expected: all pass (or only pre-existing errors remain).

- [ ] **Step 4: Run build**

Run:
```bash
bun run build
```

Expected: build succeeds.

- [ ] **Step 5: Report deletion summary**

List deleted files with line counts. Example format:
```
Deleted 15 files, ~3200 lines:
  src/core/simulation.ts       (450 lines)
  src/core/graph-state.ts      (200 lines)
  ...
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: delete dead TeamClaw pipeline code

Remove unused LangGraph pipeline, work runner, and pipeline-specific agents.
Keeps agent registry, LLM engine, tools, providers, session, TUI — all live code."
```

### Task 4: Remove unused dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Check for LangGraph dependency**

```bash
grep -i "langgraph\|@langchain" package.json
```

If `@langchain/langgraph` or similar is present and no longer imported anywhere in `src/`, remove it.

- [ ] **Step 2: Remove unused deps**

```bash
# Only if confirmed unused:
bun remove @langchain/langgraph  # or whatever the package name is
```

- [ ] **Step 3: Verify**

Run:
```bash
bun run typecheck && bun run test
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: remove unused LangGraph dependencies"
```

### Task 5: Merge Branch 1

- [ ] **Step 1: Final verification**

```bash
bun run typecheck && bun run lint && bun run test && bun run build
```

- [ ] **Step 2: Merge to staging**

```bash
git checkout staging
git merge --no-ff chore/dead-code-audit
git push origin staging
git branch -d chore/dead-code-audit
```

---

## Branch 2: SprintRunner Implementation

> Create branch `feat/sprint-mode` off `staging` (after Branch 1 is merged).

### Task 6: Create sprint types

**Files:**
- Create: `src/sprint/types.ts`
- Test: `tests/sprint/types.test.ts` (skip — pure types, no logic to test)

- [ ] **Step 1: Create `src/sprint/types.ts`**

```typescript
/**
 * Sprint mode types — lightweight autonomous task orchestration.
 */

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

export interface SprintEventMap {
  "sprint:start": { goal: string };
  "sprint:plan": { tasks: SprintTask[] };
  "sprint:task:start": { task: SprintTask; agentName: string };
  "sprint:task:complete": { task: SprintTask };
  "sprint:agent:token": { agentName: string; token: string };
  "sprint:agent:tool": {
    agentName: string;
    toolName: string;
    status: string;
    details?: {
      executionId?: string;
      inputSummary?: string;
      duration?: number;
      outputSummary?: string;
      success?: boolean;
    };
  };
  "sprint:done": { result: SprintResult };
  "sprint:error": { error: Error; task?: SprintTask };
  "sprint:paused": undefined;
  "sprint:resumed": undefined;
}
```

- [ ] **Step 2: Verify**

Run:
```bash
bun run typecheck 2>&1 | grep "sprint"
```

Expected: no errors from sprint/types.ts.

- [ ] **Step 3: Commit**

```bash
git add src/sprint/types.ts
git commit -m "feat(sprint): add sprint mode type definitions"
```

### Task 7: Create task parser with tests

**Files:**
- Create: `src/sprint/task-parser.ts`
- Create: `tests/sprint/task-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/sprint/task-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseTasks } from "../../src/sprint/task-parser.js";

describe("parseTasks", () => {
  it("parses a JSON array in a fenced code block", () => {
    const input = `Here is the plan:

\`\`\`json
[
  {"description": "Set up project structure"},
  {"description": "Create API endpoints"},
  {"description": "Write tests"}
]
\`\`\``;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.id).toBe("task-1");
    expect(tasks[0]!.description).toBe("Set up project structure");
    expect(tasks[0]!.status).toBe("pending");
    expect(tasks[2]!.id).toBe("task-3");
  });

  it("parses a numbered list", () => {
    const input = `Sprint plan:
1. Design the database schema
2. Implement user authentication
3. Create REST API endpoints
4. Write integration tests`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]!.description).toBe("Design the database schema");
    expect(tasks[3]!.description).toBe("Write integration tests");
  });

  it("parses a raw JSON array (no fencing)", () => {
    const input = `[{"description": "Task A"}, {"description": "Task B"}]`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.description).toBe("Task A");
  });

  it("returns empty array for empty input", () => {
    expect(parseTasks("")).toHaveLength(0);
    expect(parseTasks("No tasks here.")).toHaveLength(0);
  });

  it("handles numbered list with extra whitespace and markdown", () => {
    const input = `
1.  **Design** the schema
2.  Implement the **routes**
`;

    const tasks = parseTasks(input);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.description).toBe("**Design** the schema");
    expect(tasks[1]!.description).toBe("Implement the **routes**");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
bun run test -- tests/sprint/task-parser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/sprint/task-parser.ts`:

```typescript
/**
 * Task parser — extracts structured tasks from planner LLM output.
 * Tries JSON first (fenced or raw), falls back to numbered list parsing.
 */
import type { SprintTask } from "./types.js";

export function parseTasks(plannerOutput: string): SprintTask[] {
  if (!plannerOutput.trim()) return [];

  // Try JSON in fenced code block
  const fencedMatch = plannerOutput.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fencedMatch) {
    const parsed = tryParseJsonTasks(fencedMatch[1]!);
    if (parsed.length > 0) return parsed;
  }

  // Try raw JSON array
  const bracketMatch = plannerOutput.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    const parsed = tryParseJsonTasks(bracketMatch[0]!);
    if (parsed.length > 0) return parsed;
  }

  // Fallback: numbered list (1. Description, 2. Description, ...)
  return parseNumberedList(plannerOutput);
}

function tryParseJsonTasks(jsonStr: string): SprintTask[] {
  try {
    const arr = JSON.parse(jsonStr.trim());
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((item: unknown) => typeof item === "object" && item !== null && "description" in item)
      .map((item: { description: string }, i: number) => ({
        id: `task-${i + 1}`,
        description: String(item.description),
        status: "pending" as const,
      }));
  } catch {
    return [];
  }
}

function parseNumberedList(text: string): SprintTask[] {
  const tasks: SprintTask[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const match = line.match(/^\s*\d+\.\s+(.+)/);
    if (match) {
      tasks.push({
        id: `task-${tasks.length + 1}`,
        description: match[1]!.trim(),
        status: "pending",
      });
    }
  }

  return tasks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
bun run test -- tests/sprint/task-parser.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sprint/task-parser.ts tests/sprint/task-parser.test.ts
git commit -m "feat(sprint): add task parser with JSON and numbered list support"
```

### Task 8: Create SprintRunner core

**Files:**
- Create: `src/sprint/sprint-runner.ts`
- Create: `tests/sprint/sprint-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/sprint/sprint-runner.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { SprintRunner } from "../../src/sprint/sprint-runner.js";
import type { SprintTask } from "../../src/sprint/types.js";

// Minimal mock agent registry
function mockRegistry() {
  return {
    get: (id: string) => ({
      id,
      name: id,
      description: `${id} agent`,
      capabilities: [],
      defaultTools: [],
      modelTier: "primary" as const,
      systemPrompt: `You are a ${id}.`,
      canCollaborate: false,
      maxConcurrent: 1,
    }),
    getAll: () => [],
    getIds: () => [],
    has: () => true,
  } as any;
}

// Mock LLM that returns canned responses
function mockRunAgent() {
  let callCount = 0;
  return vi.fn(async (_agentName: string, _opts: any): Promise<string> => {
    callCount++;
    if (callCount === 1) {
      // Planner response
      return `1. Design the schema\n2. Implement the API\n3. Write tests`;
    }
    return `Completed task successfully.`;
  });
}

describe("SprintRunner", () => {
  it("runs a sprint with 3 tasks", async () => {
    const runner = new SprintRunner(mockRegistry());
    const runAgentMock = mockRunAgent();
    (runner as any).runAgent = runAgentMock;

    const events: string[] = [];
    runner.on("sprint:start", () => events.push("start"));
    runner.on("sprint:plan", () => events.push("plan"));
    runner.on("sprint:task:start", () => events.push("task:start"));
    runner.on("sprint:task:complete", () => events.push("task:complete"));
    runner.on("sprint:done", () => events.push("done"));

    const result = await runner.run("Build a REST API");

    expect(result.completedTasks).toBe(3);
    expect(result.failedTasks).toBe(0);
    expect(result.tasks).toHaveLength(3);

    expect(events).toEqual([
      "start", "plan",
      "task:start", "task:complete",
      "task:start", "task:complete",
      "task:start", "task:complete",
      "done",
    ]);
  });

  it("handles task failure gracefully", async () => {
    const runner = new SprintRunner(mockRegistry());
    let callCount = 0;
    (runner as any).runAgent = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return "1. Do something";
      if (callCount === 2) throw new Error("LLM timeout");
      return "Done";
    });

    const result = await runner.run("Failing goal");

    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(1);
    expect(result.tasks[0]!.status).toBe("failed");
    expect(result.tasks[0]!.error).toBe("LLM timeout");
  });

  it("can be stopped mid-sprint", async () => {
    const runner = new SprintRunner(mockRegistry());
    let callCount = 0;
    (runner as any).runAgent = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return "1. Task A\n2. Task B\n3. Task C";
      if (callCount === 2) {
        // Stop after first task executes
        runner.stop();
        return "Done A";
      }
      return "Done";
    });

    const result = await runner.run("Stoppable goal");

    // Should have completed 1 task, then stopped
    expect(result.completedTasks).toBe(1);
    expect(result.tasks.filter(t => t.status === "pending").length).toBeGreaterThan(0);
  });

  it("assigns agents based on task description keywords", () => {
    const runner = new SprintRunner(mockRegistry());
    const assign = (runner as any).assignAgent.bind(runner);

    const testTask: SprintTask = { id: "1", description: "Write unit tests for auth", status: "pending" };
    const codeTask: SprintTask = { id: "2", description: "Create user model", status: "pending" };
    const reviewTask: SprintTask = { id: "3", description: "Review the pull request", status: "pending" };
    const debugTask: SprintTask = { id: "4", description: "Debug the login bug", status: "pending" };

    expect(assign(testTask)).toBe("tester");
    expect(assign(codeTask)).toBe("coder");
    expect(assign(reviewTask)).toBe("reviewer");
    expect(assign(debugTask)).toBe("debugger");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
bun run test -- tests/sprint/sprint-runner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/sprint/sprint-runner.ts`:

```typescript
/**
 * SprintRunner — lightweight autonomous task orchestrator.
 * Plans tasks from a goal, executes them sequentially using agents
 * from the registry, and emits events for TUI rendering.
 */
import { EventEmitter } from "node:events";
import type { AgentRegistry } from "../router/agent-registry.js";
import type { SprintTask, SprintState, SprintResult, SprintOptions, SprintEventMap } from "./types.js";
import { parseTasks } from "./task-parser.js";

const PLANNER_PROMPT = (goal: string, maxTasks: number) =>
  `Break this goal into concrete, actionable tasks (max ${maxTasks}). ` +
  `Each task should be a single unit of work that one developer could complete. ` +
  `Output a numbered list:\n\nGoal: ${goal}`;

const TASK_PROMPT = (task: SprintTask, state: SprintState) => {
  const context = state.tasks
    .filter((t) => t.status === "completed" && t.result)
    .map((t) => `- ${t.description}: ${t.result!.slice(0, 200)}`)
    .join("\n");
  const prior = context ? `\n\nCompleted so far:\n${context}` : "";
  return `${task.description}${prior}\n\nWorking directory: ${process.cwd()}`;
};

const KEYWORD_RULES: Array<{ keywords: string[]; agent: string }> = [
  { keywords: ["test", "spec", "verify", "coverage"], agent: "tester" },
  { keywords: ["review", "check", "audit", "inspect"], agent: "reviewer" },
  { keywords: ["research", "investigate", "find", "search", "explore"], agent: "researcher" },
  { keywords: ["debug", "fix", "bug", "error", "crash"], agent: "debugger" },
  { keywords: ["plan", "design", "architect", "outline"], agent: "planner" },
];

export class SprintRunner extends EventEmitter {
  private state: SprintState = {
    goal: "",
    tasks: [],
    currentTaskIndex: 0,
    phase: "planning",
    startedAt: new Date().toISOString(),
    completedTasks: 0,
    failedTasks: 0,
  };
  private abortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;

  constructor(protected agents: AgentRegistry) {
    super();
  }

  async run(goal: string, options?: SprintOptions): Promise<SprintResult> {
    const startTime = Date.now();
    this.abortController = new AbortController();
    this.state = {
      goal,
      tasks: [],
      currentTaskIndex: 0,
      phase: "planning",
      startedAt: new Date().toISOString(),
      completedTasks: 0,
      failedTasks: 0,
    };
    this.emitTyped("sprint:start", { goal });

    // Phase 1: Planning
    const planResponse = await this.runAgent("planner", {
      prompt: PLANNER_PROMPT(goal, options?.maxTasks ?? 10),
      signal: this.abortController.signal,
    });
    this.state.tasks = parseTasks(planResponse);
    if (this.state.tasks.length === 0) {
      this.state.phase = "done";
      const result = this.buildResult(startTime);
      this.emitTyped("sprint:done", { result });
      return result;
    }
    this.state.phase = "executing";
    this.emitTyped("sprint:plan", { tasks: this.state.tasks });

    // Phase 2: Sequential execution
    for (let i = 0; i < this.state.tasks.length; i++) {
      await this.checkPaused();
      if (this.abortController.signal.aborted) break;

      const task = this.state.tasks[i]!;
      this.state.currentTaskIndex = i;
      const agentName = this.assignAgent(task);
      task.assignedAgent = agentName;
      task.status = "in_progress";
      this.emitTyped("sprint:task:start", { task, agentName });

      try {
        const result = await this.runAgent(agentName, {
          prompt: TASK_PROMPT(task, this.state),
          signal: this.abortController.signal,
        });
        task.result = result;
        task.status = "completed";
        this.state.completedTasks++;
      } catch (err) {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        this.state.failedTasks++;
      }
      this.emitTyped("sprint:task:complete", { task });
    }

    // Phase 3: Done
    this.state.phase = "done";
    const result = this.buildResult(startTime);
    this.emitTyped("sprint:done", { result });
    return result;
  }

  pause(): void {
    if (this.state.phase !== "executing") return;
    this.paused = true;
    this.state.phase = "paused";
    this.emitTyped("sprint:paused", undefined);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.state.phase = "executing";
    this.emitTyped("sprint:resumed", undefined);
    this.pauseResolve?.();
    this.pauseResolve = null;
  }

  stop(): void {
    this.state.phase = "stopped";
    this.abortController?.abort();
  }

  getState(): SprintState {
    return { ...this.state };
  }

  /** Override in subclass or mock for testing. */
  protected async runAgent(
    _agentName: string,
    _opts: { prompt: string; signal: AbortSignal },
  ): Promise<string> {
    throw new Error("runAgent must be wired to LLM before calling run()");
  }

  protected assignAgent(task: SprintTask): string {
    const lower = task.description.toLowerCase();
    for (const rule of KEYWORD_RULES) {
      if (rule.keywords.some((kw) => lower.includes(kw))) {
        return this.agents.has(rule.agent) ? rule.agent : "coder";
      }
    }
    return "coder";
  }

  private async checkPaused(): Promise<void> {
    if (this.paused) {
      await new Promise<void>((resolve) => {
        this.pauseResolve = resolve;
      });
    }
  }

  private buildResult(startTime: number): SprintResult {
    return {
      goal: this.state.goal,
      tasks: this.state.tasks,
      completedTasks: this.state.completedTasks,
      failedTasks: this.state.failedTasks,
      duration: Date.now() - startTime,
    };
  }

  private emitTyped<K extends keyof SprintEventMap>(
    event: K,
    data: SprintEventMap[K],
  ): void {
    this.emit(event, data);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
bun run test -- tests/sprint/sprint-runner.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sprint/sprint-runner.ts tests/sprint/sprint-runner.test.ts
git commit -m "feat(sprint): add SprintRunner core with sequential execution and pause/resume"
```

### Task 9: Create LLM-backed sprint runner factory

**Files:**
- Create: `src/sprint/create-sprint-runner.ts`

This wires `SprintRunner.runAgent` to the real LLM via `callLLMMultiTurn`, using the same pattern as `createLLMAgentRunner` in `src/router/llm-agent-runner.ts`.

- [ ] **Step 1: Write the factory**

Create `src/sprint/create-sprint-runner.ts`:

```typescript
/**
 * Factory that creates a SprintRunner wired to the real LLM engine.
 * Uses callLLMMultiTurn with the agent's system prompt and tools.
 */
import { SprintRunner } from "./sprint-runner.js";
import type { AgentRegistry } from "../router/agent-registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutor } from "../tools/executor.js";
import { callLLMMultiTurn } from "../engine/llm.js";
import { getProjectContext } from "../engine/project-context.js";

export interface CreateSprintRunnerOptions {
  agents: AgentRegistry;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
}

export function createSprintRunner(opts: CreateSprintRunnerOptions): SprintRunner {
  const { agents, toolRegistry, toolExecutor } = opts;

  const runner = new (class extends SprintRunner {
    protected override async runAgent(
      agentName: string,
      runOpts: { prompt: string; signal: AbortSignal },
    ): Promise<string> {
      const agentDef = this.agents.get(agentName);
      if (!agentDef) {
        throw new Error(`Unknown agent: ${agentName}`);
      }

      // Build system prompt with project context
      let systemPrompt = agentDef.systemPrompt;
      const projectCtx = getProjectContext(process.cwd());
      if (projectCtx) systemPrompt += projectCtx;

      // Resolve tools
      const toolNames = agentDef.defaultTools;
      const nativeTools =
        toolNames.length > 0 && toolRegistry
          ? toolRegistry.exportForAPI(toolNames)
          : [];
      const hasTools = nativeTools.length > 0 && toolExecutor;

      if (hasTools) {
        const toolList = toolNames
          .map((n) => {
            const t = toolRegistry!.get(n);
            return t ? `- ${t.name}: ${t.description}` : null;
          })
          .filter(Boolean)
          .join("\n");
        systemPrompt += `\n\nTools:\n${toolList}\n\nWorking directory: ${process.cwd()}\nUse tools directly.`;
      }

      let toolCallCounter = 0;

      const response = await callLLMMultiTurn({
        systemPrompt,
        userMessage: runOpts.prompt,
        nativeTools: hasTools ? nativeTools : undefined,
        handleTool: async (name, args) => {
          const execId = `sprint_tc_${++toolCallCounter}`;
          const inputSummary = `${name}(${JSON.stringify(args).slice(0, 100)})`;
          const startTime = Date.now();

          this.emit("sprint:agent:tool", {
            agentName,
            toolName: name,
            status: "running",
            details: { executionId: execId, inputSummary },
          });

          try {
            const result = await toolExecutor!.execute(name, args);
            const duration = Date.now() - startTime;
            this.emit("sprint:agent:tool", {
              agentName,
              toolName: name,
              status: "completed",
              details: { executionId: execId, duration, outputSummary: result.slice(0, 200), success: true },
            });
            return result;
          } catch (e) {
            const duration = Date.now() - startTime;
            const msg = e instanceof Error ? e.message : String(e);
            this.emit("sprint:agent:tool", {
              agentName,
              toolName: name,
              status: "failed",
              details: { executionId: execId, duration, outputSummary: msg, success: false },
            });
            return `Error: ${msg}`;
          }
        },
        onChunk: (token) => {
          this.emit("sprint:agent:token", { agentName, token });
        },
        signal: runOpts.signal,
        maxTurns: 10,
      });

      return response.text;
    }

  })(agents);

  return runner;
}
```

- [ ] **Step 2: Check that `getProjectContext` exists**

Run:
```bash
grep -rn "export.*getProjectContext" src/engine/ --include="*.ts"
```

If it doesn't exist, check the actual name used in `llm-agent-runner.ts` and adjust the import.

- [ ] **Step 3: Check ToolExecutor.execute signature**

Run:
```bash
grep -n "execute(" src/tools/executor.ts | head -5
```

Adjust the `toolExecutor!.execute(name, args)` call to match the actual signature.

- [ ] **Step 4: Verify**

Run:
```bash
bun run typecheck 2>&1 | grep "sprint"
```

Expected: no errors from sprint files.

- [ ] **Step 5: Commit**

```bash
git add src/sprint/create-sprint-runner.ts
git commit -m "feat(sprint): add LLM-backed sprint runner factory"
```

### Task 10: Create `/sprint` command

**Files:**
- Create: `src/app/commands/sprint.ts`

- [ ] **Step 1: Write the command**

Create `src/app/commands/sprint.ts`:

```typescript
/**
 * /sprint command — autonomous multi-agent sprint mode.
 * Subcommands: /sprint <goal>, /sprint stop, /sprint status, /sprint plan
 */
import type { SlashCommand } from "../../tui/index.js";
import type { AppLayout } from "../layout.js";
import type { AgentRegistry } from "../../router/agent-registry.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ToolExecutor } from "../../tools/executor.js";
import { createSprintRunner } from "../../sprint/create-sprint-runner.js";
import { renderPanel, panelSection } from "../../tui/components/panel.js";
import type { SprintRunner } from "../../sprint/sprint-runner.js";
import type { SprintTask } from "../../sprint/types.js";

export interface SprintCommandDeps {
  agents: AgentRegistry;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  layout: AppLayout;
}

let activeRunner: SprintRunner | null = null;

function agentDisplayName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function formatTaskList(tasks: SprintTask[]): string {
  return tasks
    .map((t, i) => {
      const icon = t.status === "completed" ? "+" : t.status === "failed" ? "x" : t.status === "in_progress" ? ">" : " ";
      const agent = t.assignedAgent ? ` [${t.assignedAgent}]` : "";
      return `  ${icon} ${i + 1}. ${t.description}${agent}`;
    })
    .join("\n");
}

export function createSprintCommand(deps: SprintCommandDeps): SlashCommand {
  return {
    name: "sprint",
    aliases: ["sp"],
    description: "Autonomous multi-agent sprint mode",
    args: "<goal> | stop | status | plan | resume",
    async execute(args, ctx) {
      const sub = args.trim().split(/\s+/)[0] || "";

      // /sprint stop
      if (sub === "stop") {
        if (!activeRunner) {
          ctx.addMessage("system", "No active sprint.");
          return;
        }
        activeRunner.stop();
        ctx.addMessage("system", "Sprint stopped.");
        activeRunner = null;
        return;
      }

      // /sprint status
      if (sub === "status") {
        if (!activeRunner) {
          ctx.addMessage("system", "No active sprint.");
          return;
        }
        const state = activeRunner.getState();
        const lines = [
          ...panelSection("Sprint Status"),
          `  Goal:      ${state.goal}`,
          `  Phase:     ${state.phase}`,
          `  Progress:  ${state.completedTasks}/${state.tasks.length} tasks done, ${state.failedTasks} failed`,
          `  Current:   ${state.tasks[state.currentTaskIndex]?.description ?? "none"}`,
        ];
        const panel = renderPanel({ title: "Sprint" }, lines);
        ctx.addMessage("system", panel.join("\n"));
        return;
      }

      // /sprint plan
      if (sub === "plan") {
        if (!activeRunner) {
          ctx.addMessage("system", "No active sprint.");
          return;
        }
        const state = activeRunner.getState();
        ctx.addMessage("system", `Sprint Plan:\n\n${formatTaskList(state.tasks)}`);
        return;
      }

      // /sprint resume
      if (sub === "resume") {
        if (!activeRunner) {
          ctx.addMessage("system", "No sprint to resume.");
          return;
        }
        activeRunner.resume();
        return;
      }

      // /sprint <goal> — start a new sprint
      const goal = args.trim();
      if (!goal) {
        ctx.addMessage("error", "Usage: /sprint <goal>");
        return;
      }
      if (activeRunner) {
        ctx.addMessage("error", "Sprint already running. Use /sprint stop first.");
        return;
      }

      const runner = createSprintRunner({
        agents: deps.agents,
        toolRegistry: deps.toolRegistry,
        toolExecutor: deps.toolExecutor,
      });
      activeRunner = runner;

      // Wire events to TUI
      const { layout } = deps;

      runner.on("sprint:start", (data: { goal: string }) => {
        ctx.addMessage("system", `Sprint Started: ${data.goal}`);
      });

      runner.on("sprint:plan", (data: { tasks: SprintTask[] }) => {
        ctx.addMessage("system", `Sprint Plan (${data.tasks.length} tasks):\n\n${formatTaskList(data.tasks)}`);
      });

      runner.on("sprint:task:start", (data: { task: SprintTask; agentName: string }) => {
        layout.messages.addMessage({
          role: "agent",
          agentName: agentDisplayName(data.agentName),
          content: "",
          timestamp: new Date(),
        });
        layout.tui.requestRender();
      });

      runner.on("sprint:agent:token", (data: { agentName: string; token: string }) => {
        layout.messages.appendToLast(data.token);
        layout.tui.requestRender();
      });

      runner.on("sprint:agent:tool", (data: {
        agentName: string;
        toolName: string;
        status: string;
        details?: { executionId?: string; inputSummary?: string; duration?: number; outputSummary?: string; success?: boolean };
      }) => {
        const execId = data.details?.executionId ?? `sprint_${Date.now()}`;
        if (data.status === "running") {
          layout.messages.startToolCall(execId, data.toolName, data.details?.inputSummary ?? data.toolName, data.agentName);
        } else if (data.status === "completed" || data.status === "failed") {
          layout.messages.completeToolCall(
            execId,
            data.status === "completed",
            data.details?.outputSummary ?? "",
            data.details?.duration ?? 0,
          );
        }
        layout.tui.requestRender();
      });

      runner.on("sprint:task:complete", (data: { task: SprintTask }) => {
        const icon = data.task.status === "completed" ? "+" : "x";
        const msg = data.task.status === "completed"
          ? `${icon} Task complete: ${data.task.description}`
          : `${icon} Task failed: ${data.task.description} — ${data.task.error}`;
        ctx.addMessage("system", msg);
      });

      runner.on("sprint:paused", () => {
        ctx.addMessage("system", "Sprint paused. /sprint resume to continue, /sprint stop to terminate.");
      });

      runner.on("sprint:done", (data: { result: import("../../sprint/types.js").SprintResult }) => {
        const r = data.result;
        const lines = [
          ...panelSection("Sprint Complete"),
          `  Goal:      ${r.goal}`,
          `  Tasks:     ${r.completedTasks} completed, ${r.failedTasks} failed`,
          `  Duration:  ${(r.duration / 1000).toFixed(1)}s`,
        ];
        const panel = renderPanel({ title: "Sprint Done" }, lines);
        ctx.addMessage("system", panel.join("\n"));
        activeRunner = null;
      });

      // Run the sprint (blocks until done/stopped)
      try {
        await runner.run(goal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.addMessage("error", `Sprint error: ${msg}`);
        activeRunner = null;
      }
    },
  };
}
```

- [ ] **Step 2: Verify**

Run:
```bash
bun run typecheck 2>&1 | grep "sprint"
```

Expected: no errors (or only pre-existing ones unrelated to sprint).

- [ ] **Step 3: Commit**

```bash
git add src/app/commands/sprint.ts
git commit -m "feat(sprint): add /sprint command with subcommands (stop, status, plan, resume)"
```

### Task 11: Register `/sprint` command in app/index.ts

**Files:**
- Modify: `src/app/index.ts`

- [ ] **Step 1: Find where commands are registered**

Run:
```bash
grep -n "registry.register\|createPlanCommand\|createCompactCommand" src/app/index.ts | head -15
```

Identify the section where commands are registered after the session/router is initialized (near `initSessionRouter`).

- [ ] **Step 2: Add sprint command registration**

In `src/app/index.ts`, in the `initSessionRouter` function, after the existing command registrations (near where `createCompactCommand` or `createPlanCommand` is registered), add:

```typescript
// Register sprint command
{
  const { createSprintCommand } = await import("./commands/sprint.js");
  registry.register(createSprintCommand({
    agents: ctx.router.getRegistry(),
    toolRegistry: toolRegistry ?? undefined,
    toolExecutor: toolExecutor ?? undefined,
    layout,
  }));
}
```

Note: Check how `ctx.router.getRegistry()` actually exposes the agent registry. It might be `ctx.router.agents` or a different accessor. Verify with:

```bash
grep -n "getRegistry\|get agents\|agentRegistry\|\.agents" src/router/prompt-router.ts | head -10
```

Adjust the accessor accordingly.

- [ ] **Step 3: Verify**

Run:
```bash
bun run typecheck 2>&1 | grep "sprint"
```

- [ ] **Step 4: Commit**

```bash
git add src/app/index.ts
git commit -m "feat(sprint): register /sprint command in TUI"
```

### Task 12: Add sprint barrel export

**Files:**
- Create: `src/sprint/index.ts`

- [ ] **Step 1: Create barrel export**

Create `src/sprint/index.ts`:

```typescript
export { SprintRunner } from "./sprint-runner.js";
export { createSprintRunner } from "./create-sprint-runner.js";
export { parseTasks } from "./task-parser.js";
export type { SprintTask, SprintState, SprintResult, SprintOptions, SprintPhase, SprintEventMap } from "./types.js";
```

- [ ] **Step 2: Commit**

```bash
git add src/sprint/index.ts
git commit -m "feat(sprint): add barrel export"
```

### Task 13: Full verification and merge

- [ ] **Step 1: Run all checks**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bun run build
```

Fix any errors.

- [ ] **Step 2: Manual test**

Launch the TUI and test:

```
/sprint add user authentication
```

Verify:
- Sprint starts, planner generates tasks
- Tasks execute sequentially with agent labels
- Tool calls display inline
- Sprint summary shows at completion

Test pause:
- Start a sprint, press `Ctrl+C` during execution
- Verify "Sprint paused" message
- Run `/sprint resume` — verify it continues
- Run `/sprint status` — verify progress display
- Run `/sprint plan` — verify task list

- [ ] **Step 3: Merge to staging**

```bash
git checkout staging
git merge --no-ff feat/sprint-mode
git push origin staging
git branch -d feat/sprint-mode
```
