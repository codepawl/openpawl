/**
 * Clarifying question generator — max 3 questions, severity-ordered.
 */

import type { ClarityIssue } from "./types.js";

export interface ClarityQuestion {
  issue: ClarityIssue;
  question: string;
  placeholder?: string;
}

/**
 * Generate clarifying questions from issues.
 * Returns at most 3 questions, prioritizing blocking issues.
 */
export function generateQuestions(issues: ClarityIssue[]): ClarityQuestion[] {
  if (issues.length === 0) return [];

  // Sort: blocking first, then advisory
  const sorted = [...issues].sort((a, b) => {
    if (a.severity === "blocking" && b.severity !== "blocking") return -1;
    if (a.severity !== "blocking" && b.severity === "blocking") return 1;
    return 0;
  });

  // Deduplicate by type — one question per type
  const seen = new Set<string>();
  const deduped: ClarityIssue[] = [];
  for (const issue of sorted) {
    if (!seen.has(issue.type)) {
      seen.add(issue.type);
      deduped.push(issue);
    }
  }

  // Take max 3
  return deduped.slice(0, 3).map((issue) => ({
    issue,
    question: issue.question,
    placeholder: getPlaceholder(issue),
  }));
}

function getPlaceholder(issue: ClarityIssue): string | undefined {
  switch (issue.type) {
    case "vague_verb":
      return "e.g., add rate limiting, fix the N+1 query";
    case "unspecified_noun":
      return "e.g., the auth API, the PostgreSQL database";
    case "missing_success_criteria":
      return "e.g., p99 < 200ms, 100% test coverage";
    case "ambiguous_constraint":
      return "e.g., reduce from 500ms to under 200ms";
    case "missing_scope":
      return "e.g., only the public endpoints, not internal";
    case "conflicting_requirements":
      return "e.g., prioritize simplicity over completeness";
    case "too_broad":
      return "e.g., focus on the API layer only";
    default:
      return undefined;
  }
}
