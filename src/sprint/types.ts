/**
 * Sprint mode types — lightweight autonomous task orchestration.
 */

export interface SprintTask {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "incomplete";
  assignedAgent?: string;
  result?: string;
  error?: string;
  /** Tool names called during this task's execution. */
  toolsCalled?: string[];
  /** 1-based task indices that must complete before this task can start. */
  dependsOn?: number[];
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
  "sprint:warning": { warning: string; type: string; taskIndex?: number };
  "sprint:paused": undefined;
  "sprint:resumed": undefined;
}
