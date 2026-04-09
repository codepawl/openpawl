/**
 * Heuristic forecast method — wraps the existing preview estimator.
 * Used when no historical data or profile data is available.
 */

import type { PreviewTask } from "../../graph/preview/types.js";
import type { AgentForecast, PhaseForecast } from "../types.js";

// Average tokens per task type (rough estimates)
const AVG_TOKENS_SIMPLE = 2000;
const AVG_TOKENS_COMPLEX = 6000;

export interface HeuristicResult {
  estimatedMinUSD: number;
  estimatedMaxUSD: number;
  estimatedMidUSD: number;
  agentForecasts: AgentForecast[];
  phaseForecasts: PhaseForecast[];
}

/**
 * Estimate cost using simple task complexity heuristics.
 * This is the fallback method when no historical or profile data exists.
 */
export function forecastHeuristic(
  tasks: PreviewTask[],
  model: string,
): HeuristicResult {
  // Group tasks by assigned agent
  const agentTasks = new Map<string, PreviewTask[]>();
  for (const task of tasks) {
    const agent = task.assigned_to || "worker_task";
    const existing = agentTasks.get(agent) ?? [];
    existing.push(task);
    agentTasks.set(agent, existing);
  }

  const agentForecasts: AgentForecast[] = [];

  for (const [agent, agentTaskList] of agentTasks) {
    let estimatedTokens = 0;
    for (const task of agentTaskList) {
      const isComplex = task.complexity === "HIGH" || task.complexity === "ARCHITECTURE";
      estimatedTokens += isComplex ? AVG_TOKENS_COMPLEX : AVG_TOKENS_SIMPLE;
    }

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

  const phaseForecasts = estimatePhases(tasks);

  return {
    estimatedMinUSD: 0,
    estimatedMaxUSD: 0,
    estimatedMidUSD: 0,
    agentForecasts,
    phaseForecasts,
  };
}

function estimatePhases(tasks: PreviewTask[]): PhaseForecast[] {
  const execTasks = tasks.length;
  const estimatedReworks = Math.max(1, Math.round(execTasks / 5));

  return [
    { phase: "planning", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: 1 },
    { phase: "execution", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: execTasks },
    { phase: "review", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: Math.ceil(execTasks * 0.5) },
    { phase: "rework", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: estimatedReworks },
  ];
}
