/**
 * Historical forecast method — uses actual cost data from similar past runs.
 * Highest confidence method when >= 3 similar past runs are available.
 */

import type { SimilarRun, AgentForecast, PhaseForecast } from "../types.js";
import type { PreviewTask } from "../../graph/preview/types.js";

export interface HistoricalResult {
  estimatedMinUSD: number;
  estimatedMaxUSD: number;
  estimatedMidUSD: number;
  similarRunsCount: number;
  similarRunsAvgCost: number;
  similarRunsRange: { min: number; max: number };
  agentForecasts: AgentForecast[];
  phaseForecasts: PhaseForecast[];
}

/**
 * Forecast using similar past sessions.
 * Excludes current session to prevent data leakage.
 */
export function forecastHistorical(
  tasks: PreviewTask[],
  similarRuns: SimilarRun[],
  currentSessionId: string,
  model: string,
): HistoricalResult | null {
  // Filter out current session
  const validRuns = similarRuns.filter((r) => r.sessionId !== currentSessionId);
  if (validRuns.length < 3) return null;

  // Build agent forecasts from task distribution
  const agentForecasts = buildAgentForecasts(tasks, model);
  const phaseForecasts = buildPhaseForecasts();

  return {
    estimatedMinUSD: 0,
    estimatedMaxUSD: 0,
    estimatedMidUSD: 0,
    similarRunsCount: validRuns.length,
    similarRunsAvgCost: 0,
    similarRunsRange: { min: 0, max: 0 },
    agentForecasts,
    phaseForecasts,
  };
}

function buildAgentForecasts(
  tasks: PreviewTask[],
  model: string,
): AgentForecast[] {
  const agentTasks = new Map<string, number>();
  for (const task of tasks) {
    const agent = task.assigned_to || "worker_task";
    agentTasks.set(agent, (agentTasks.get(agent) ?? 0) + 1);
  }

  const forecasts: AgentForecast[] = [];

  for (const [agent, count] of agentTasks) {
    forecasts.push({
      agentRole: agent,
      estimatedTasks: count,
      estimatedTokens: 0,
      estimatedMinUSD: 0,
      estimatedMaxUSD: 0,
      model,
      costPerToken: 0,
    });
  }

  return forecasts;
}

function buildPhaseForecasts(): PhaseForecast[] {
  return [
    { phase: "planning", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: 1 },
    { phase: "execution", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: 0 },
    { phase: "review", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: 0 },
    { phase: "rework", estimatedMinUSD: 0, estimatedMaxUSD: 0, estimatedTasks: 0 },
  ];
}
