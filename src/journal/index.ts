/**
 * Decision journal — barrel export.
 */

export type { Decision, SupersessionAlert, DecisionSearchResult } from "./types.js";
export { extractDecisions } from "./extractor.js";
export type { ExtractionInput } from "./extractor.js";
export { DecisionStore } from "./store.js";
export { checkSupersession, detectContradiction } from "./supersession.js";
export { withDecisionContext } from "./prompt.js";
