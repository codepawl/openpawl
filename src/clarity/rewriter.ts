/**
 * Goal rewriter — combines original goal + clarifying answers into a clearer statement.
 * No LLM calls — template-based rewriting.
 */

import type { ClarityIssue } from "./types.js";

export interface ClarificationAnswer {
  issue: ClarityIssue;
  answer: string;
}

/**
 * Rewrite a goal by incorporating clarification answers.
 */
export function rewriteGoal(originalGoal: string, answers: ClarificationAnswer[]): string {
  if (answers.length === 0) return originalGoal;

  let rewritten = originalGoal;

  // Process answers by type, building up the rewritten goal
  for (const { issue, answer } of answers) {
    if (!answer.trim()) continue;

    switch (issue.type) {
      case "vague_verb":
        rewritten = replaceVagueVerb(rewritten, issue.fragment, answer);
        break;
      case "unspecified_noun":
        rewritten = replaceUnspecifiedNoun(rewritten, issue.fragment, answer);
        break;
      case "missing_success_criteria":
        rewritten = appendSuccessCriteria(rewritten, answer);
        break;
      case "ambiguous_constraint":
        rewritten = appendConstraint(rewritten, answer);
        break;
      case "missing_scope":
        rewritten = appendScope(rewritten, answer);
        break;
      case "conflicting_requirements":
        rewritten = appendPriority(rewritten, answer);
        break;
      case "too_broad":
        rewritten = narrowScope(rewritten, answer);
        break;
    }
  }

  return cleanGoal(rewritten);
}

function replaceVagueVerb(goal: string, fragment: string, answer: string): string {
  const regex = new RegExp(`\\b${escapeRegex(fragment)}\\b`, "i");
  return goal.replace(regex, answer.trim());
}

function replaceUnspecifiedNoun(goal: string, fragment: string, answer: string): string {
  const regex = new RegExp(`\\b${escapeRegex(fragment)}\\b`, "i");
  return goal.replace(regex, answer.trim());
}

function appendSuccessCriteria(goal: string, criteria: string): string {
  return `${goal.replace(/[.\s]+$/, "")} — target ${criteria.trim()}`;
}

function appendConstraint(goal: string, constraint: string): string {
  return `${goal.replace(/[.\s]+$/, "")} (${constraint.trim()})`;
}

function appendScope(goal: string, scope: string): string {
  return `${goal.replace(/[.\s]+$/, "")} — scope: ${scope.trim()}`;
}

function appendPriority(goal: string, priority: string): string {
  return `${goal.replace(/[.\s]+$/, "")} — priority: ${priority.trim()}`;
}

function narrowScope(goal: string, focus: string): string {
  return `${focus.trim()} (from: ${goal.trim()})`;
}

function cleanGoal(goal: string): string {
  return goal
    .replace(/\s{2,}/g, " ")
    .replace(/\s+—\s+—/g, " —")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
