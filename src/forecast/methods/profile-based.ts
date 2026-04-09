/**
 * Profile-based forecast method — estimates cost from agent profiles.
 * Medium confidence method when profiles have >= 5 samples per task type.
 */

import type { AgentForecast, PhaseForecast } from "../types.js";
import type { PreviewTask } from "../../graph/preview/types.js";

export interface ProfileTaskTypeScore {
  taskType: string;
  averageConfidence: number;
  totalTasksCompleted: number;
  averageReworkCount: number;
}

export interface AgentProfileData {
  agentRole: string;
  taskTypeScores: ProfileTaskTypeScore[];
  overallScore: number;
  totalTasksCompleted: number;
}

export interface ProfileBasedResult {
  estimatedMinUSD: number;
  estimatedMaxUSD: number;
  estimatedMidUSD: number;
  agentForecasts: AgentForecast[];
  phaseForecasts: PhaseForecast[];
}

// Average tokens per task type based on typical patterns
const TASK_TYPE_TOKENS: Record<string, number> = {
  audit: 2500,
  research: 3000,
  implement: 4000,
  test: 2000,
  refactor: 3500,
  document: 2000,
  design: 5000,
  debug: 3000,
  general: 2500,
};

const MIN_SAMPLES_PER_TYPE = 5;

/**
 * Forecast using agent profile data.
 * Returns null if profiles lack sufficient samples.
 */
export function forecastProfileBased(
  tasks: PreviewTask[],
  profiles: AgentProfileData[],
  model: string,
): ProfileBasedResult | null {
  if (profiles.length === 0) return null;

  // Check if we have enough samples
  const hasEnoughData = profiles.some((p) =>
    p.taskTypeScores.some((ts) => ts.totalTasksCompleted >= MIN_SAMPLES_PER_TYPE),
  );
  if (!hasEnoughData) return null;

  // Group tasks by agent
  const agentTasks = new Map<string, PreviewTask[]>();
  for (const task of tasks) {
    const agent = task.assigned_to || "worker_task";
    const existing = agentTasks.get(agent) ?? [];
    existing.push(task);
    agentTasks.set(agent, existing);
  }

  const agentForecasts: AgentForecast[] = [];

  for (const [agent, agentTaskList] of agentTasks) {
    const profile = profiles.find((p) => p.agentRole === agent);

    let estimatedTokens = 0;
    let estimatedReworks = 0;

    for (const task of agentTaskList) {
      const taskType = classifyTaskType(task.description);
      const typeTokens = TASK_TYPE_TOKENS[taskType] ?? TASK_TYPE_TOKENS.general;

      // Adjust tokens based on profile: higher confidence → fewer retries → fewer tokens
      const profileScore = profile?.taskTypeScores.find((ts) => ts.taskType === taskType);
      const confidenceFactor = profileScore
        ? 1 + (1 - profileScore.averageConfidence) * 0.5 // Lower confidence = more tokens
        : 1.2; // No profile data = assume 20% overhead
      const reworkRate = profileScore?.averageReworkCount ?? 0.5;

      estimatedTokens += Math.round(typeTokens * confidenceFactor);
      estimatedReworks += reworkRate;
    }

    // Add rework token estimate
    estimatedTokens += Math.round(estimatedReworks * 2000);

    agentForecasts.push({
      agentRole: agent,
      estimatedTasks: agentTaskList.length,
      estimatedTokens,
      estimatedMinUSD: 0,
      estimatedMaxUSD: 0,
      model,
      costPerToken: 0,
    });
  }

  const phaseForecasts = buildPhaseForecasts(0, tasks.length);

  return {
    estimatedMinUSD: 0,
    estimatedMaxUSD: 0,
    estimatedMidUSD: 0,
    agentForecasts,
    phaseForecasts,
  };
}

function buildPhaseForecasts(_totalCost: number, taskCount: number): PhaseForecast[] {
  return [
    { phase: "planning", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: 1 },
    { phase: "execution", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: taskCount },
    { phase: "review", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: Math.ceil(taskCount * 0.5) },
    { phase: "rework", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: Math.max(1, Math.round(taskCount / 5)) },
  ];
}

function classifyTaskType(description: string): string {
  const lower = description.toLowerCase();
  const keywords: Record<string, string[]> = {
    audit: ["audit", "review", "inspect"],
    research: ["research", "investigate", "analyze"],
    implement: ["implement", "build", "create", "develop", "code"],
    test: ["test", "validate", "spec"],
    refactor: ["refactor", "clean", "optimize"],
    document: ["document", "docs", "readme"],
    design: ["design", "architect", "plan"],
    debug: ["debug", "fix", "resolve"],
  };
  for (const [type, kws] of Object.entries(keywords)) {
    if (kws.some((kw) => lower.includes(kw))) return type;
  }
  return "general";
}
