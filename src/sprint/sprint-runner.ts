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
