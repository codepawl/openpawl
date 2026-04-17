/**
 * Sprint mode types — lightweight autonomous task orchestration.
 */

export interface SprintToolCallResult {
  /** Tool name. */
  name: string;
  /** Shell exit code for shell_exec (and tools that wrap it). */
  exitCode?: number;
  /** First ~200 chars of stderr for shell_exec. */
  stderrHead?: string;
}

export interface SprintTask {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "incomplete";
  assignedAgent?: string;
  result?: string;
  error?: string;
  /** Tool names called during this task's execution (deduped). */
  toolsCalled?: string[];
  /** Per-call tool results with structured metadata (exit code, stderr head). Not deduped. */
  toolCallResults?: SprintToolCallResult[];
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
  inputTokens: number;
  outputTokens: number;
}

export interface SprintResult {
  goal: string;
  tasks: SprintTask[];
  completedTasks: number;
  failedTasks: number;
  duration: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SprintTeamContext {
  templateId: string;
  templateName: string;
  pipeline: string[];
  agents: Array<{ role: string; task?: string }>;
  mode: "template" | "manual";
}

export interface SprintOptions {
  /** Max tasks the planner should generate. Default: 10. */
  maxTasks?: number;
  /** Max concurrent tasks when running in parallel. Default: 3. */
  maxConcurrency?: number;
  /** Team template context — when set, planner and agent assignment use template roles. */
  teamContext?: SprintTeamContext;
  /** Lessons from previous runs — injected into the planner prompt. */
  lessons?: string[];
}

export interface SprintEventMap {
  "sprint:start": { goal: string };
  "sprint:composition": { entries: Array<{ role: string; task: string; included: boolean; reason: string }>; estimatedTasks: number };
  "sprint:plan": { tasks: SprintTask[] };
  "sprint:round:start": { round: number; tasks: SprintTask[] };
  "sprint:round:complete": { round: number; duration: number };
  "sprint:task:start": { task: SprintTask; agentName: string };
  "sprint:task:complete": { task: SprintTask; taskIndex?: number; totalTasks?: number };
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
  "sprint:needs_clarification": { questions: string[] };
  "sprint:error": { error: Error; task?: SprintTask };
  "sprint:warning": { warning: string; type: string; taskIndex?: number };
  "sprint:planning": undefined;
  "sprint:paused": undefined;
  "sprint:resumed": undefined;
}
