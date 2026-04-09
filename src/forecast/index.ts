export type {
  CostForecast,
  AgentForecast,
  PhaseForecast,
  ForecastPhase,
  MultiRunProjection,
  ModelSuggestion,
  ForecastMethod,
  ConfidenceLevel,
  ModelRecommendation,
  ForecastAccuracyEntry,
  SimilarRun,
} from "./types.js";
export { generateForecast } from "./engine.js";
export type { ForecastInput } from "./engine.js";
export { forecastHeuristic } from "./methods/heuristic.js";
export { forecastHistorical } from "./methods/historical.js";
export { forecastProfileBased } from "./methods/profile-based.js";
export type { AgentProfileData } from "./methods/profile-based.js";
export { projectMultiRunCost } from "./learning-discount.js";
export type { LearningCurveData } from "./learning-discount.js";
export { suggestModelSwaps } from "./model-suggester.js";
export type { AgentCostData } from "./model-suggester.js";
export {
  recordAccuracy,
  getAccuracyHistory,
  getAccuracyByMethod,
  getBiasCorrection,
  getAccuracyStats,
} from "./tracker.js";
