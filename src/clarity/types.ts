/**
 * Types for goal clarity checking.
 */

export type ClarityIssueType =
  | "vague_verb"
  | "unspecified_noun"
  | "missing_scope"
  | "missing_success_criteria"
  | "ambiguous_constraint"
  | "conflicting_requirements"
  | "too_broad";

export interface ClarityIssue {
  type: ClarityIssueType;
  fragment: string;
  question: string;
  severity: "blocking" | "advisory";
}

export interface ClarityResult {
  isClear: boolean;
  score: number;
  issues: ClarityIssue[];
  suggestions: string[];
  checkedAt: number;
}

export type ClarityResolution = "clarified" | "proceeded" | "rephrased" | "aborted" | "split";

export interface ClarityHistoryEntry {
  sessionId: string;
  originalGoal: string;
  clarifiedGoal?: string;
  clarityScore: number;
  issues: ClarityIssue[];
  resolution: ClarityResolution;
  ignoredIssueTypes: ClarityIssueType[];
  recordedAt: number;
}
