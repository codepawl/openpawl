/**
 * Main forecast engine — selects best method and produces CostForecast.
 * Never makes LLM calls. Read-only: never modifies global memory.
 */

import type {
  CostForecast,
  SimilarRun,
  ForecastMethod,
  ConfidenceLevel,
} from "./types.js";
import type { PreviewTask } from "../graph/preview/types.js";
import { forecastHistorical } from "./methods/historical.js";
import { forecastProfileBased, type AgentProfileData } from "./methods/profile-based.js";
import { forecastHeuristic } from "./methods/heuristic.js";
import { projectMultiRunCost, type LearningCurveData } from "./learning-discount.js";
import { suggestModelSwaps, type AgentCostData } from "./model-suggester.js";
import { getBiasCorrection } from "./tracker.js";

export interface ForecastInput {
  sessionId: string;
  goal: string;
  tasks: PreviewTask[];
  model: string;
  runs?: number;
  similarRuns?: SimilarRun[];
  profiles?: AgentProfileData[];
  learningCurve?: LearningCurveData;
}

/**
 * Generate a full cost forecast using the best available method.
 *
 * Method selection:
 * 1. Historical (>= 3 similar runs) → high confidence
 * 2. Profile-based (profiles with >= 5 samples) → medium confidence
 * 3. Heuristic (fallback) → low confidence
 */
export function generateForecast(input: ForecastInput): CostForecast {
  const {
    sessionId, goal, tasks, model, runs = 1,
    similarRuns = [], profiles = [], learningCurve,
  } = input;

  let method: ForecastMethod;
  let confidenceLevel: ConfidenceLevel;
  let confidenceReason: string;
  let estimatedMinUSD: number;
  let estimatedMaxUSD: number;
  let estimatedMidUSD: number;
  let similarRunsCount = 0;
  let similarRunsAvgCost = 0;
  let similarRunsRange = { min: 0, max: 0 };
  let agentForecasts = [];
  let phaseForecasts = [];

  // Try historical first
  const historicalResult = forecastHistorical(tasks, similarRuns, sessionId, model);
  if (historicalResult) {
    method = "historical";
    confidenceLevel = "high";
    confidenceReason = `based on ${historicalResult.similarRunsCount} similar past runs`;
    estimatedMinUSD = historicalResult.estimatedMinUSD;
    estimatedMaxUSD = historicalResult.estimatedMaxUSD;
    estimatedMidUSD = historicalResult.estimatedMidUSD;
    similarRunsCount = historicalResult.similarRunsCount;
    similarRunsAvgCost = historicalResult.similarRunsAvgCost;
    similarRunsRange = historicalResult.similarRunsRange;
    agentForecasts = historicalResult.agentForecasts;
    phaseForecasts = historicalResult.phaseForecasts;
  } else {
    // Try profile-based
    const profileResult = forecastProfileBased(tasks, profiles, model);
    if (profileResult) {
      method = "profile_based";
      confidenceLevel = "medium";
      confidenceReason = `based on agent profile data (${profiles.length} profiles)`;
      estimatedMinUSD = profileResult.estimatedMinUSD;
      estimatedMaxUSD = profileResult.estimatedMaxUSD;
      estimatedMidUSD = profileResult.estimatedMidUSD;
      agentForecasts = profileResult.agentForecasts;
      phaseForecasts = profileResult.phaseForecasts;
    } else {
      // Fallback to heuristic
      method = "heuristic";
      confidenceLevel = "low";
      confidenceReason = "no similar past runs or profile data found";
      const heuristicResult = forecastHeuristic(tasks, model);
      estimatedMinUSD = heuristicResult.estimatedMinUSD;
      estimatedMaxUSD = heuristicResult.estimatedMaxUSD;
      estimatedMidUSD = heuristicResult.estimatedMidUSD;
      agentForecasts = heuristicResult.agentForecasts;
      phaseForecasts = heuristicResult.phaseForecasts;
    }
  }

  // Apply bias correction
  const biasCorrection = getBiasCorrection(method);
  if (biasCorrection !== 1.0) {
    estimatedMinUSD = round(estimatedMinUSD * biasCorrection);
    estimatedMaxUSD = round(estimatedMaxUSD * biasCorrection);
    estimatedMidUSD = round(estimatedMidUSD * biasCorrection);
  }

  // Multi-run projection
  const multiRunProjection = projectMultiRunCost(estimatedMidUSD, runs, learningCurve);

  // Model suggestions
  const agentCostData: AgentCostData[] = agentForecasts.map((f) => ({
    agentRole: f.agentRole,
    currentModel: f.model,
    estimatedCostUSD: (f.estimatedMinUSD + f.estimatedMaxUSD) / 2,
    averageConfidence: 0.8, // Will be overridden with actual profile data if available
  }));
  const modelSuggestions = suggestModelSwaps(agentCostData);

  return {
    sessionId,
    goal,
    estimatedMinUSD,
    estimatedMaxUSD,
    estimatedMidUSD,
    confidenceLevel,
    confidenceReason,
    similarRunsCount,
    similarRunsAvgCost,
    similarRunsRange,
    agentForecasts,
    phaseForecasts,
    multiRunProjection,
    modelSuggestions,
    forecastMethod: method,
    generatedAt: Date.now(),
  };
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}
