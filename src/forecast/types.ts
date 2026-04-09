/**
 * Types for cost forecasting.
 */

export type ForecastMethod = "historical" | "profile_based" | "heuristic";
export type ConfidenceLevel = "high" | "medium" | "low";
export type ModelRecommendation = "switch" | "consider" | "keep";

export interface CostForecast {
  sessionId: string;
  goal: string;
  estimatedMinUSD: number;
  estimatedMaxUSD: number;
  estimatedMidUSD: number;
  confidenceLevel: ConfidenceLevel;
  confidenceReason: string;
  similarRunsCount: number;
  similarRunsAvgCost: number;
  similarRunsRange: { min: number; max: number };
  agentForecasts: AgentForecast[];
  phaseForecasts: PhaseForecast[];
  multiRunProjection: MultiRunProjection;
  modelSuggestions: ModelSuggestion[];
  forecastMethod: ForecastMethod;
  generatedAt: number;
}

export interface AgentForecast {
  agentRole: string;
  estimatedTasks: number;
  estimatedTokens: number;
  estimatedMinUSD: number;
  estimatedMaxUSD: number;
  model: string;
  costPerToken: number;
}

export type ForecastPhase = "planning" | "execution" | "review" | "rework" | "retrospective";

export interface PhaseForecast {
  phase: ForecastPhase;
  estimatedMinUSD: number;
  estimatedMaxUSD: number;
  estimatedTasks: number;
}

export interface MultiRunProjection {
  runs: number;
  naiveCost: number;
  projectedCost: number;
  savingsPct: number;
  savingsUSD: number;
  breakEvenRun: number;
}

export interface ModelSuggestion {
  agentRole: string;
  currentModel: string;
  suggestedModel: string;
  estimatedSavingsPct: number;
  estimatedConfidenceDrop: number;
  recommendation: ModelRecommendation;
}

export interface ForecastAccuracyEntry {
  sessionId: string;
  forecastMethod: string;
  estimatedMidUSD: number;
  actualUSD: number;
  errorPct: number;
  similarRunsUsed: number;
  recordedAt: number;
}

export interface SimilarRun {
  sessionId: string;
  goal: string;
  averageConfidence: number;
  totalRuns: number;
  teamComposition: string[];
  similarity: number;
}
