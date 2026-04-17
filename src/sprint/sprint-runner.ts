/**
 * SprintRunner — lightweight autonomous task orchestrator.
 * Plans tasks from a goal, executes them sequentially using agents
 * from the registry, and emits events for TUI rendering.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentRegistry } from "../router/agent-registry.js";
import type { SprintTask, SprintState, SprintResult, SprintOptions, SprintEventMap, SprintTeamContext } from "./types.js";
import { mapTemplateRoleToAgent } from "./team-resolver.js";
import { analyzeGoal } from "./goal-analyzer.js";
import { parseTasks } from "./task-parser.js";
import { validatePlan, reorderSetupFirst } from "./plan-validator.js";
import { profileMeasure } from "../telemetry/profiler.js";
import { resolveModelForAgent } from "../core/model-config.js";
import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "../debug/logger.js";
import { classifyTask, type ErrorKind } from "./error-classify.js";

const PLANNER_PROMPT = (goal: string, maxTasks: number, teamContext?: SprintTeamContext, lessons?: string[]) => {
  let prompt =
    `You are planning a sprint to accomplish this goal: "${goal}"\n\n` +
    `STEP 1 — GOAL ANALYSIS:\n` +
    `Before generating tasks, identify the 3-5 core feature areas the goal requires.\n` +
    `Example: "coffee shop website" → menu display, product pages, shopping cart, order checkout, admin dashboard.\n` +
    `Example: "todo app" → task list view, add/edit/delete tasks, filters/search, persistence.\n` +
    `Think about what a USER of this product would actually use.\n\n` +
    `STEP 2 — TASK ALLOCATION (max ${maxTasks} tasks):\n` +
    `Distribute tasks across the feature areas you identified:\n` +
    `- Task 1: ALWAYS project setup (init project, install deps, create config)\n` +
    `- Tasks 2–${Math.max(3, maxTasks - 1)}: Core features from your goal analysis. ` +
    `Most tasks (60-80%) should directly implement what the user asked for. ` +
    `Do NOT fill the plan with generic auth/login/CRUD — only include auth if the goal requires it.\n` +
    `- Last task: ALWAYS testing (write and run tests to verify the build)\n` +
    `- If the goal implies a web app, include at least one frontend/UI task.\n\n` +
    `RULES:\n` +
    `1. GOAL FOCUS: Task descriptions must be specific to the domain. ` +
    `"Create src/pages/menu.tsx with coffee product cards, prices, and add-to-cart buttons" NOT "Implement /api/users endpoint".\n` +
    `2. DEPENDENCY ORDER: Order tasks so dependencies come first. ` +
    `If task N needs output from task M, M must come first. Include "dependsOn" with 1-based task numbers.\n` +
    `3. MVP SCOPE: Build the MINIMUM viable version. Do NOT add:\n` +
    `   - Payment (Stripe, PayPal), email (SendGrid, Nodemailer), OAuth/social login, Docker, CI/CD, monitoring — unless explicitly requested\n` +
    `4. NO ASSUMED LIBRARIES: Only use technologies explicitly mentioned in the goal. ` +
    `If the goal says PostgreSQL, use pg driver directly, not an ORM unless specified. ` +
    `If the goal doesn't specify a library for something, use the simplest built-in approach.\n` +
    `5. SPECIFICITY: Each task must name the exact file path relative to the working directory root, what it should contain, and the technology to use. ` +
    `File paths must NOT include the project folder name — the agent's cwd is already inside it. Use "src/index.ts" NOT "my-project/src/index.ts".\n` +
    `6. TECH CONSTRAINTS: Every task description MUST repeat the specific technologies from the goal (database, framework, language, libraries). ` +
    `Example: "Implement auth routes using PostgreSQL for user storage, bcrypt for passwords, Zod for validation" — NOT just "Implement auth routes".\n` +
    `7. WORKER-READY: Each task must include enough detail for a coder to implement without re-reading the full plan: ` +
    `key function/export names, expected input/output, and which other tasks it depends on.\n` +
    `8. SETUP FIRST: When the goal is to build something new, Task 1 must always be project initialization: ` +
    `create directory, init package.json, install specified dependencies, create config files. Never skip setup.\n` +
    `9. NO QUESTIONS AS TASKS: NEVER output clarification questions as tasks. Every task description must start with an action verb ` +
    `(Create, Implement, Write, Set up, Configure, Build, Add, Install, Test, Deploy). ` +
    `If the goal is too vague to decompose into actionable tasks, respond with EXACTLY:\n` +
    `NEEDS_CLARIFICATION: followed by your questions, one per line. Do NOT wrap questions in JSON or task format.\n\n`;

  if (teamContext) {
    const agentList = teamContext.agents
      .map((a) => `- ${a.role}${a.task ? `: ${a.task}` : ""}`)
      .join("\n");
    prompt +=
      `TEAM CONTEXT:\n` +
      `You are working as part of the "${teamContext.templateName}" team.\n` +
      `Available agents:\n${agentList}\n\n` +
      `Pipeline order: ${teamContext.pipeline.join(" → ")}\n\n` +
      `Tag each task with the agent role that should execute it using the "agent" field.\n\n` +
      `Output as a JSON array:\n` +
      `[{"description": "...", "agent": "${teamContext.pipeline[0] ?? "coder"}", "dependsOn": []}, ` +
      `{"description": "...", "agent": "${teamContext.pipeline[1] ?? "coder"}", "dependsOn": [1]}]\n\n`;
  } else {
    prompt +=
      `Output as a JSON array:\n` +
      `[{"description": "...", "dependsOn": []}, {"description": "...", "dependsOn": [1]}]\n\n`;
  }

  if (lessons && lessons.length > 0) {
    prompt += `LESSONS FROM PREVIOUS RUNS (you MUST apply these):\n`;
    for (const lesson of lessons) {
      prompt += `- ${lesson}\n`;
    }
    prompt += `\n`;
  }

  prompt += `Goal: ${goal}`;
  return prompt;
};

const TASK_PROMPT = (task: SprintTask, state: SprintState) => {
  const context = state.tasks
    .filter((t) => (t.status === "completed" || (t.status === "failed" && t.result)) && t.result)
    .map((t) => {
      const label = t.status === "completed" ? "completed" : "partial (failed)";
      return `- ${t.description} [${label}]: ${t.result!.slice(0, 200)}`;
    })
    .join("\n");
  const prior = context ? `\n\nPrior work:\n${context}` : "";
  return `Goal: ${state.goal}\n\nYour task: ${task.description}${prior}\n\nWorking directory: ${process.cwd()}`;
};

/**
 * Patterns in model IDs that indicate small models (<7B params).
 * Sprint mode requires stronger reasoning; warn the user.
 */
const SMALL_MODEL_PATTERNS = [
  /\b(1\.?[0-5]b|2b|3b|4b|5b|6b|7b)\b/i,      // explicit param counts ≤7B
  /\bmini\b/i,                                    // "mini" variants
  /\b(phi-?[23]|gemma-?2b|tinyllama|smollm)\b/i, // known small models
  /\bhaiku\b/i,                                   // Claude Haiku (smaller tier)
];

function isSmallModel(modelId: string): boolean {
  return SMALL_MODEL_PATTERNS.some((p) => p.test(modelId));
}

/**
 * Keywords in task descriptions that imply the agent must write/modify files.
 * Ambiguous words ("install", "setup", "configure") previously lived here but
 * triggered validation on no-op tasks like `npm install`, so they are dropped.
 * False negatives (missing a write-intent task) are preferred over false
 * positives (retrying a no-op task).
 */
const WRITE_INTENT_KEYWORDS = ["create", "build", "implement", "write", "add", "generate"];

/**
 * Tools that constitute a write action. `shell_exec` is intentionally excluded
 * because it has too many non-write uses (`ls`, `cat`, `which`, test runners)
 * and counting it previously let tasks pass validation without producing any
 * file. Tasks that legitimately only need shell (e.g. "run tests") should
 * have descriptions without WRITE_INTENT_KEYWORDS, causing `taskExpectsWrite`
 * to return false.
 */
const WRITE_TOOLS = new Set(["file_write", "file_edit"]);

/**
 * Match file paths mentioned in task descriptions. Covers relative paths
 * (`src/foo.ts`), bare filenames with extensions (`package.json`,
 * `README.md`), and nested paths (`src/__tests__/bar.test.ts`).
 */
const FILE_PATH_REGEX = /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|sh|py|rs|go|html|css|txt|lock)\b|\b(?:package\.json|tsconfig\.json|README\.md|CHANGELOG\.md|\.gitignore|LICENSE|[\w-]+\.(?:ts|tsx|js|jsx|md|yml|yaml|toml|sh|py|rs|go))\b/g;

/** Extract clarification questions if planner responded with NEEDS_CLARIFICATION. */
function extractClarification(response: string): string[] | null {
  const trimmed = response.trim();
  // Check for explicit NEEDS_CLARIFICATION marker
  const marker = "NEEDS_CLARIFICATION:";
  const idx = trimmed.indexOf(marker);
  if (idx === -1) return null;

  const questionsText = trimmed.slice(idx + marker.length).trim();
  const questions = questionsText
    .split("\n")
    .map((l) => l.replace(/^[-\d.)\s*]+/, "").trim())
    .filter((l) => l.length > 0);

  return questions.length > 0 ? questions : null;
}

/** Patterns that indicate a task description is actually a question, not an action. */
const QUESTION_PREFIXES = /^(what|which|how\s+should|do\s+you|should\s+we|can\s+you|where|when|why|is\s+there|are\s+there|would)/i;

/** Filter out tasks that are questions or otherwise non-actionable. */
function filterInvalidTasks(tasks: SprintTask[]): SprintTask[] {
  return tasks.filter((task) => {
    const desc = task.description.trim();
    // Reject questions
    if (desc.endsWith("?")) return false;
    if (QUESTION_PREFIXES.test(desc)) return false;
    return true;
  });
}

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
    inputTokens: 0,
    outputTokens: 0,
  };
  private abortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;
  private teamContext: SprintTeamContext | undefined;

  constructor(protected agents: AgentRegistry) {
    super();
  }

  async run(goal: string, options?: SprintOptions): Promise<SprintResult> {
    const startTime = Date.now();
    this.abortController = new AbortController();
    this.teamContext = options?.teamContext;
    this.state = {
      goal,
      tasks: [],
      currentTaskIndex: 0,
      phase: "planning",
      startedAt: new Date().toISOString(),
      completedTasks: 0,
      failedTasks: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    this.emitTyped("sprint:start", { goal });

    // Check model capability — warn if model appears too small for multi-step tasks
    const activeModel = resolveModelForAgent("default");
    if (isSmallModel(activeModel)) {
      this.emitTyped("sprint:error", {
        error: new Error(
          `Model "${activeModel}" may be too small for sprint mode. ` +
          `Multi-step autonomous tasks require stronger reasoning (recommended: 70B+ params or equivalent). ` +
          `Consider switching to a larger model with /model.`,
        ),
      });
    }

    // Autonomous composition: analyze goal and emit team composition
    if (!this.teamContext) {
      const analysis = analyzeGoal(goal);
      this.emitTyped("sprint:composition", {
        entries: analysis.entries,
        estimatedTasks: analysis.estimatedTasks,
      });
    }

    // Phase 1: Planning
    this.emitTyped("sprint:planning", undefined);
    let planResponse: string;
    try {
      const raw = await profileMeasure("sprint_planning", goal.slice(0, 40), () =>
        this.runAgent("planner", {
          prompt: PLANNER_PROMPT(goal, options?.maxTasks ?? 10, this.teamContext, options?.lessons),
          signal: this.abortController!.signal,
        }),
      );
      if (typeof raw === "string") {
        planResponse = raw;
      } else {
        planResponse = raw.text;
        this.state.inputTokens += raw.usage.input;
        this.state.outputTokens += raw.usage.output;
      }
    } catch (err) {
      this.state.phase = "stopped";
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitTyped("sprint:error", { error });
      throw err;
    }
    // Check for NEEDS_CLARIFICATION response
    const clarification = extractClarification(planResponse);
    if (clarification) {
      this.state.phase = "stopped";
      this.emitTyped("sprint:needs_clarification", { questions: clarification });
      return this.buildResult(startTime);
    }

    this.state.tasks = parseTasks(planResponse);

    // Validate tasks — filter out questions and invalid entries
    const _preFilterCount = this.state.tasks.length;
    this.state.tasks = filterInvalidTasks(this.state.tasks);
    if (isDebugEnabled() && _preFilterCount !== this.state.tasks.length) {
      debugLog("info", "sprint", "sprint:task_validation", {
        data: {
          beforeCount: _preFilterCount,
          afterCount: this.state.tasks.length,
          filtered: _preFilterCount - this.state.tasks.length,
        },
      });
    }
    if (this.state.tasks.length === 0) {
      // All tasks were invalid (likely all questions) — treat as needs clarification
      this.state.phase = "stopped";
      this.emitTyped("sprint:needs_clarification", {
        questions: ["The goal is too vague to decompose into actionable tasks. Please provide more detail."],
      });
      return this.buildResult(startTime);
    }

    // Validate plan and emit warnings
    const warnings = validatePlan(this.state.tasks, goal);
    for (const w of warnings) {
      this.emitTyped("sprint:warning", { warning: w.message, type: w.type, taskIndex: w.taskIndex });
    }

    // Auto-fix: move setup task to front if it exists but isn't first
    if (warnings.some(w => w.type === "missing_setup")) {
      reorderSetupFirst(this.state.tasks);
    }

    this.state.phase = "executing";
    this.emitTyped("sprint:plan", { tasks: this.state.tasks });

    // Phase 2: Dependency-aware execution (parallel when possible)
    const maxConcurrency = options?.maxConcurrency ?? 3;
    const tasks = this.state.tasks;
    const useParallel = tasks.length >= 3 && tasks.some((t) => t.dependsOn && t.dependsOn.length > 0);

    // Debug: log task dependency graph and execution mode
    if (isDebugEnabled()) {
      const depGraph: Record<string, number[]> = {};
      for (const t of tasks) {
        depGraph[t.id] = t.dependsOn ?? [];
      }
      debugLog("info", "sprint", "sprint:dependency_graph", {
        data: { depGraph, executionMode: useParallel ? "parallel" : "sequential", maxConcurrency },
      });
    }

    if (useParallel) {
      await this.executeParallel(tasks, maxConcurrency);
    } else {
      await this.executeSequential(tasks);
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
    // Unblock if paused, so the execution loop can reach the abort check
    this.pauseResolve?.();
    this.pauseResolve = null;
    this.paused = false;
    this.abortController?.abort();
  }

  getState(): SprintState {
    return { ...this.state };
  }

  // ── Sequential execution (fallback / small plans) ───────────────────

  private async executeSequential(tasks: SprintTask[]): Promise<void> {
    for (let i = 0; i < tasks.length; i++) {
      await this.checkPaused();
      if (this.abortController!.signal.aborted) break;
      const task = tasks[i]!;

      // Soft dependency check: skip only if dep produced NO output at all
      const deps = task.dependsOn ?? [];
      const hardFail = deps.some((d) => {
        const dep = tasks[d - 1];
        return dep && dep.status === "failed" && !dep.result && !(dep.toolsCalled?.length);
      });
      if (hardFail) {
        task.status = "failed";
        task.error = "Skipped: dependency produced no output";
        this.state.failedTasks++;
        this.emitTyped("sprint:task:complete", { task, taskIndex: i + 1, totalTasks: this.state.tasks.length });
        continue;
      }

      await this.executeTask(task, i);

      // Single retry for non-timeout, non-skip failures (includes incomplete)
      if ((task.status === "failed" || task.status === "incomplete") && this.isRetriable(task)) {
        await this.retryTask(task, i);
      }
    }
  }

  // ── Parallel execution (dependency-aware rounds) ───────────────────

  private async executeParallel(tasks: SprintTask[], maxConcurrency: number): Promise<void> {
    // Build completed set (1-based indices)
    const completed = new Set<number>();
    const failed = new Set<number>();
    let round = 0;

    while (completed.size + failed.size < tasks.length) {
      await this.checkPaused();
      if (this.abortController!.signal.aborted) break;

      // Find tasks whose dependencies are resolved (completed or failed-with-output)
      const ready: number[] = [];
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]!;
        if (task.status !== "pending") continue;
        const deps = task.dependsOn ?? [];

        // Soft dependency: skip only if a failed dep produced NO output at all
        const failedDeps = deps.filter((d) => failed.has(d));
        if (failedDeps.length > 0) {
          const hasPartialOutput = failedDeps.some((d) => {
            const dep = tasks[d - 1];
            return dep && (dep.result || (dep.toolsCalled?.length ?? 0) > 0);
          });
          if (!hasPartialOutput) {
            task.status = "failed";
            task.error = "Skipped: dependency produced no output";
            this.state.failedTasks++;
            this.emitTyped("sprint:task:complete", { task, taskIndex: i + 1, totalTasks: tasks.length });
            continue;
          }
          // Dep failed but produced partial output — allow this task to attempt
        }

        // All deps must be resolved (completed or in the failed set)
        if (deps.every((d) => completed.has(d) || failed.has(d))) {
          ready.push(i);
        }
      }

      if (ready.length === 0) {
        // Deadlock or all done
        break;
      }

      round++;
      // Limit concurrency
      const batch = ready.slice(0, maxConcurrency);
      const batchTasks = batch.map((i) => tasks[i]!);
      this.emitTyped("sprint:round:start", { round, tasks: batchTasks });
      const roundStart = Date.now();

      // Execute batch in parallel
      await Promise.all(
        batch.map((i) => this.executeTask(tasks[i]!, i)),
      );

      // Update completed/failed sets
      for (const i of batch) {
        const task = tasks[i]!;
        const taskNum = i + 1; // 1-based
        if (task.status === "completed") {
          completed.add(taskNum);
        } else {
          failed.add(taskNum);
        }
      }

      // Retry failed tasks from this batch once (skip timeouts and skips)
      const retriable = batch.filter((i) => (tasks[i]!.status === "failed" || tasks[i]!.status === "incomplete") && this.isRetriable(tasks[i]!));
      for (const i of retriable) {
        await this.retryTask(tasks[i]!, i);
        const taskNum = i + 1;
        if (tasks[i]!.status === "completed") {
          failed.delete(taskNum);
          completed.add(taskNum);
        }
      }

      this.emitTyped("sprint:round:complete", { round, duration: Date.now() - roundStart });
    }
  }

  // ── Single task execution ──────────────────────────────────────────

  private async executeTask(task: SprintTask, index: number): Promise<void> {
    this.state.currentTaskIndex = index;
    const agentName = this.assignAgent(task);
    task.assignedAgent = agentName;

    // Debug: log task assignment
    if (isDebugEnabled()) {
      debugLog("info", "sprint", "sprint:task_assignment", {
        data: {
          taskId: task.id,
          agent: agentName,
          description: truncateStr(task.description, 100),
          hasTemplate: !!this.teamContext,
        },
      });
    }
    task.status = "in_progress";
    task.toolsCalled = [];
    task.toolCallResults = [];
    this.emitTyped("sprint:task:start", { task, agentName });

    try {
      const raw = await profileMeasure("sprint_task", `task_${index + 1}_${agentName}`, () =>
        this.runAgent(agentName, {
          prompt: TASK_PROMPT(task, this.state),
          signal: this.abortController!.signal,
          taskIndex: index,
        }),
      );

      // Extract text + usage from new return shape (backward-compat with plain string)
      if (typeof raw === "string") {
        task.result = raw;
      } else {
        task.result = raw.text;
        this.state.inputTokens += raw.usage.input;
        this.state.outputTokens += raw.usage.output;
      }

      if (this.taskExpectsWrite(task) && !this.taskDidWrite(task)) {
        task.status = "incomplete";
        const shellFail = this.lastShellFailure(task);
        task.error = shellFail
          ? `Task expects file creation/modification but last shell_exec failed with exit ${shellFail.exitCode}${shellFail.stderrHead ? `: ${shellFail.stderrHead}` : ""}`
          : "Task expects file creation/modification but agent only performed read operations";
        this.state.failedTasks++;
      } else if (this.taskExpectsWrite(task)) {
        // Belt-and-suspenders: task says "create src/foo.ts" and the agent
        // called a write tool, but did the file actually land? Catches cases
        // where the agent wrote to the wrong path.
        const missing = this.missingDescribedFiles(task);
        if (missing.length > 0) {
          task.status = "incomplete";
          task.error = `Task described creating ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""} but file${missing.length === 1 ? " does" : "s do"} not exist`;
          this.state.failedTasks++;
        } else {
          task.status = "completed";
          this.state.completedTasks++;
        }
      } else {
        task.status = "completed";
        this.state.completedTasks++;
      }
    } catch (err) {
      task.status = "failed";
      const base = err instanceof Error ? err.message : String(err);
      const shellFail = this.lastShellFailure(task);
      task.error = shellFail ? `${base} (last shell exit ${shellFail.exitCode})` : base;
      this.state.failedTasks++;
    }
    this.emitTyped("sprint:task:complete", { task, taskIndex: index + 1, totalTasks: this.state.tasks.length });
  }

  /**
   * Decide whether a failed task should be retried. Structured classifier
   * (error-classify.ts) is consulted first — env_* and timeout kinds skip
   * retry because the same agent in the same environment cannot recover.
   * Falls back to string-based exclusions for pre-PR-#76 edge cases.
   */
  private isRetriable(task: SprintTask): boolean {
    const err = task.error ?? "";

    // Hard exclusions — abort and dependency-skip are terminal regardless of kind
    if (err.includes("Skipped:") || err.includes("aborted")) return false;

    const { kind, signal } = classifyTask(task);
    const nonRetriableKinds: ErrorKind[] = [
      "env_command_not_found",
      "env_missing_dep",
      "env_perm",
      "env_port_in_use",
      "timeout",
    ];
    const willRetry = !nonRetriableKinds.includes(kind);

    if (isDebugEnabled()) {
      debugLog("info", "sprint", "sprint:retry_gate", {
        data: {
          taskId: task.id,
          kind,
          signal,
          willRetry,
          errorHead: truncateStr(err, 120),
        },
      });
    }

    if (!willRetry) return false;

    // Fallback string-based exclusions for cases where the classifier
    // returned "unknown" but the error text still looks terminal.
    if (err.includes("timeout") || err.includes("Timed out")) return false;

    return true;
  }

  /** Retry a failed task once with error context appended. */
  private async retryTask(task: SprintTask, index: number): Promise<void> {
    const origError = task.error ?? "unknown";
    const origDesc = task.description;

    // Debug: log retry attempt
    if (isDebugEnabled()) {
      debugLog("info", "sprint", "sprint:task_retry", {
        data: {
          taskId: task.id,
          originalError: truncateStr(origError, TRUNCATION.goalText),
          taskIndex: index,
        },
      });
    }

    // Reset task state
    task.status = "pending";
    task.error = undefined;
    task.result = undefined;
    task.toolsCalled = [];
    task.toolCallResults = [];
    this.state.failedTasks--;

    this.emitTyped("sprint:warning", {
      warning: `Retrying task ${index + 1}: "${origDesc.slice(0, 50)}..."`,
      type: "retry",
    });

    // Append error context so the LLM tries a different approach
    task.description = origDesc +
      `\n\n[RETRY — previous attempt failed: ${origError.slice(0, 150)}. Try a different approach.]`;

    await this.executeTask(task, index);

    // Restore original description (keep retry result)
    task.description = origDesc;
  }

  /** Override in subclass or mock for testing. */
  protected async runAgent(
    _agentName: string,
    _opts: { prompt: string; signal: AbortSignal; taskIndex?: number },
  ): Promise<string | { text: string; usage: { input: number; output: number } }> {
    throw new Error("runAgent must be wired to LLM before calling run()");
  }

  /**
   * Record a tool call for a task. When `taskIndex` is given, attribute to
   * that task directly — required under parallel execution, where the shared
   * `state.currentTaskIndex` races between concurrent `executeTask` frames.
   * Falls back to `currentTaskIndex` for sequential callers that don't thread
   * the index.
   */
  recordToolCall(
    toolName: string,
    info?: { exitCode?: number; stderrHead?: string },
    taskIndex?: number,
  ): void {
    const idx = taskIndex ?? this.state.currentTaskIndex;
    const task = this.state.tasks[idx];
    if (task && task.status === "in_progress") {
      task.toolsCalled ??= [];
      if (!task.toolsCalled.includes(toolName)) {
        task.toolsCalled.push(toolName);
      }
      task.toolCallResults ??= [];
      task.toolCallResults.push({ name: toolName, exitCode: info?.exitCode, stderrHead: info?.stderrHead });
    }
  }

  /** Check if a task description implies file creation/modification. */
  private taskExpectsWrite(task: SprintTask): boolean {
    const lower = task.description.toLowerCase();
    return WRITE_INTENT_KEYWORDS.some((kw) => lower.includes(kw));
  }

  /** Check if any write tools were called during this task. */
  private taskDidWrite(task: SprintTask): boolean {
    return (task.toolsCalled ?? []).some((t) => WRITE_TOOLS.has(t));
  }

  /**
   * Return file paths the task description mentioned that do not currently
   * exist on disk. Empty when the description names no paths or all of them
   * exist. Used as a final gate after `taskDidWrite` — catches agents that
   * wrote to the wrong location.
   */
  private missingDescribedFiles(task: SprintTask): string[] {
    const matches = task.description.match(FILE_PATH_REGEX);
    if (!matches || matches.length === 0) return [];
    const cwd = process.cwd();
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const rel of matches) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const abs = isAbsolute(rel) ? rel : join(cwd, rel);
      if (!existsSync(abs)) missing.push(rel);
    }
    return missing;
  }

  /** Find the last shell_exec call that returned a non-zero exit code, if any. */
  private lastShellFailure(task: SprintTask): { exitCode: number; stderrHead?: string } | undefined {
    const results = task.toolCallResults ?? [];
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i]!;
      if (r.name === "shell_exec" && typeof r.exitCode === "number" && r.exitCode !== 0) {
        return { exitCode: r.exitCode, stderrHead: r.stderrHead };
      }
    }
    return undefined;
  }

  protected assignAgent(task: SprintTask): string {
    // Template mode: use planner-assigned role or map template roles
    if (this.teamContext) {
      // If planner tagged the task with an agent role, map it
      if (task.assignedAgent) {
        const mapped = mapTemplateRoleToAgent(task.assignedAgent);
        if (this.agents.has(mapped)) return mapped;
      }
      // Fall through to keyword matching
    }

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
      inputTokens: this.state.inputTokens,
      outputTokens: this.state.outputTokens,
    };
  }

  private emitTyped<K extends keyof SprintEventMap>(
    event: K,
    data: SprintEventMap[K],
  ): void {
    this.emit(event, data);
  }
}
