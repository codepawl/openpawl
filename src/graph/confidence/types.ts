/**
 * Confidence scoring types and constants.
 */

export type ConfidenceFlag =
  | "missing_context"
  | "ambiguous_requirements"
  | "untested_approach"
  | "partial_completion"
  | "external_dependency"
  | "high_complexity";

export interface ConfidenceScore {
  score: number;
  reasoning: string;
  flags: ConfidenceFlag[];
}

export interface ConfidenceThresholds {
  autoApprove: number;
  reviewRequired: number;
  reworkRequired: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  autoApprove: 0.85,
  reviewRequired: 0.60,
  reworkRequired: 0.40,
};

export type RoutingDecision = "auto_approved" | "qa_review" | "rework" | "escalated";

const _knownFlags = new Set<string>([
  "missing_context",
  "ambiguous_requirements",
  "untested_approach",
  "partial_completion",
  "external_dependency",
  "high_complexity",
]);

export const KNOWN_FLAGS: ReadonlySet<string> = _knownFlags;

/** Register additional confidence flags (used by custom agents). */
export function registerConfidenceFlags(flags: string[]): void {
  for (const f of flags) _knownFlags.add(f);
}
