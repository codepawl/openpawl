/**
 * Goal clarity checking — barrel export.
 */

export type {
  ClarityResult,
  ClarityIssue,
  ClarityIssueType,
  ClarityResolution,
  ClarityHistoryEntry,
} from "./types.js";
export {
  analyzeClarity,
  calculateClarityScore,
  hasSuccessCriteria,
  hasMetrics,
  VAGUE_VERBS,
  UNSPECIFIED_NOUNS,
  SUCCESS_CRITERIA_SIGNALS,
} from "./analyzer.js";
export { generateQuestions } from "./questioner.js";
export type { ClarityQuestion } from "./questioner.js";
export { rewriteGoal } from "./rewriter.js";
export type { ClarificationAnswer } from "./rewriter.js";
export { detectBreadth, suggestSplits, DOMAIN_KEYWORDS } from "./breadth-analyzer.js";
export type { BreadthResult } from "./breadth-analyzer.js";
export { generateSuggestions } from "./suggester.js";
export { ClarityHistoryStore } from "./history.js";
