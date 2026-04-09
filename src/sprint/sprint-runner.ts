/**
 * SprintRunner — lightweight autonomous task orchestrator.
 * Plans tasks from a goal, executes them sequentially using agents
 * from the registry, and emits events for TUI rendering.
 */
import { EventEmitter } from "node:events";
import type { AgentRegistry } from "../router/agent-registry.js";
import type { SprintTask, SprintState, SprintResult, SprintOptions, SprintEventMap } from "./types.js";
import { parseTasks } from "./task-parser.js";
import { validatePlan, reorderSetupFirst } from "./plan-validator.js";
import { resolveModelForAgent } from "../core/model-config.js";

const PLANNER_PROMPT = (goal: string, maxTasks: number) =>
  `Break this goal into concrete, actionable tasks (max ${maxTasks}). ` +
  `Each task should be a single unit of work that one developer could complete.\n\n` +
  `RULES:\n` +
  `1. TASK ORDER: Task 1 MUST be project setup (init project, install dependencies, create config). ` +
  `The last task MUST be testing (write and run tests to verify everything works).\n` +
  `2. DEPENDENCY ORDER: Order tasks by dependency chain. Database/schema before auth. ` +
  `Auth before protected routes. Shared utilities before features that use them. ` +
  `If task N needs output from task M, M must come first. Include "dependsOn" with 1-based task numbers.\n` +
  `3. MVP SCOPE: Build the MINIMUM viable version. Do NOT add:\n` +
  `   - Payment processing (Stripe, PayPal) unless explicitly requested\n` +
  `   - Email services (SendGrid, EmailJS, Nodemailer) unless explicitly requested\n` +
  `   - OAuth/social login unless explicitly requested\n` +
  `   - Docker, CI/CD, monitoring, analytics unless explicitly requested\n` +
  `4. NO ASSUMED LIBRARIES: Only use libraries/ORMs (Prisma, TypeORM, Mongoose, Drizzle) ` +
  `if the user specifically mentioned them. Prefer built-in or standard-library approaches.\n` +
  `5. SPECIFICITY: Each task must specify:\n` +
  `   - The exact file path to create or modify\n` +
  `   - What the file should contain (endpoints, functions, components, schemas)\n` +
  `   - Good: "Create src/server.ts using Bun.serve with GET /health and POST /users endpoints"\n` +
  `   - Bad: "Set up the backend"\n\n` +
  `Output as a JSON array:\n` +
  `[{"description": "...", "dependsOn": []}, {"description": "...", "dependsOn": [1]}]\n\n` +
  `Goal: ${goal}`;

const TASK_PROMPT = (task: SprintTask, state: SprintState) => {
  const context = state.tasks
    .filter((t) => t.status === "completed" && t.result)
    .map((t) => `- ${t.description}: ${t.result!.slice(0, 200)}`)
    .join("\n");
  const prior = context ? `\n\nCompleted so far:\n${context}` : "";
  return `${task.description}${prior}\n\nWorking directory: ${process.cwd()}`;
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

/** Keywords in task descriptions that imply the agent must write/modify files. */
const WRITE_INTENT_KEYWORDS = ["create", "build", "implement", "write", "add", "generate", "set up", "setup", "configure", "install"];
/** Tools that constitute a write action. */
const WRITE_TOOLS = new Set(["file_write", "file_edit", "shell_exec"]);

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

    // Phase 1: Planning
    let planResponse: string;
    try {
      planResponse = await this.runAgent("planner", {
        prompt: PLANNER_PROMPT(goal, options?.maxTasks ?? 10),
        signal: this.abortController.signal,
      });
    } catch (err) {
      this.state.phase = "stopped";
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitTyped("sprint:error", { error });
      throw err;
    }
    this.state.tasks = parseTasks(planResponse);
    if (this.state.tasks.length === 0) {
      this.state.phase = "done";
      const result = this.buildResult(startTime);
      this.emitTyped("sprint:done", { result });
      return result;
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

    // Phase 2: Sequential execution
    for (let i = 0; i < this.state.tasks.length; i++) {
      await this.checkPaused();
      if (this.abortController.signal.aborted) break;

      const task = this.state.tasks[i]!;
      this.state.currentTaskIndex = i;
      const agentName = this.assignAgent(task);
      task.assignedAgent = agentName;
      task.status = "in_progress";
      task.toolsCalled = [];
      this.emitTyped("sprint:task:start", { task, agentName });

      try {
        const result = await this.runAgent(agentName, {
          prompt: TASK_PROMPT(task, this.state),
          signal: this.abortController.signal,
        });
        task.result = result;

        // Validate: if task implies writing but agent never wrote, mark incomplete
        if (this.taskExpectsWrite(task) && !this.taskDidWrite(task)) {
          task.status = "incomplete";
          task.error = "Task expects file creation/modification but agent only performed read operations";
        } else {
          task.status = "completed";
          this.state.completedTasks++;
        }
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
    // Unblock if paused, so the execution loop can reach the abort check
    this.pauseResolve?.();
    this.pauseResolve = null;
    this.paused = false;
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

  /** Record a tool call for the currently executing task. */
  recordToolCall(toolName: string): void {
    const task = this.state.tasks[this.state.currentTaskIndex];
    if (task && task.status === "in_progress") {
      task.toolsCalled ??= [];
      if (!task.toolsCalled.includes(toolName)) {
        task.toolsCalled.push(toolName);
      }
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
