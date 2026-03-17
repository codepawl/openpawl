/**
 * Goal suggestion generator — template-based improvement suggestions.
 * No LLM calls.
 */

import type { ClarityIssue } from "./types.js";

/**
 * Generate 2-3 rephrased versions of the goal that would score higher.
 */
export function generateSuggestions(goal: string, issues: ClarityIssue[]): string[] {
  if (issues.length === 0) return [];

  const suggestions: string[] = [];
  const hasVague = issues.find((i) => i.type === "vague_verb");
  const hasUnspecified = issues.find((i) => i.type === "unspecified_noun");
  const hasMissing = issues.find((i) => i.type === "missing_success_criteria");
  const hasBroad = issues.find((i) => i.type === "too_broad");

  // Suggestion 1: replace vague verb with action-oriented alternative
  if (hasVague) {
    const specific = getSpecificVerb(hasVague.fragment);
    const replaced = goal.replace(
      new RegExp(`\\b${escapeRegex(hasVague.fragment)}\\b`, "i"),
      specific,
    );
    suggestions.push(replaced.trim());
  }

  // Suggestion 2: add success criteria if missing
  if (hasMissing && !hasBroad) {
    suggestions.push(`${goal.replace(/[.\s]+$/, "")} — with measurable success criteria`);
  }

  // Suggestion 3: narrow scope if too broad or unspecified
  if (hasUnspecified) {
    const narrowed = goal.replace(
      new RegExp(`\\b${escapeRegex(hasUnspecified.fragment)}\\b`, "i"),
      `[specify which ${hasUnspecified.fragment.replace(/^the\s+/i, "")}]`,
    );
    suggestions.push(narrowed.trim());
  }

  // Suggestion for broad goals: pick first domain
  if (hasBroad) {
    suggestions.push(`Focus on one domain at a time. ${goal.replace(/[.\s]+$/, "")} — pick the highest-priority area`);
  }

  return suggestions.slice(0, 3);
}

function getSpecificVerb(vagueVerb: string): string {
  const replacements: Record<string, string> = {
    "improve": "add [specific feature] to",
    "fix": "resolve [specific issue] in",
    "update": "migrate [component] to [version] in",
    "enhance": "add [capability] to",
    "handle": "implement [handler] for",
    "deal with": "resolve",
    "make better": "optimize [metric] of",
    "optimize": "reduce [metric] of",
    "clean up": "refactor [module] in",
    "refactor": "restructure [module] in",
    "revisit": "re-evaluate [decision] about",
    "look at": "audit",
    "work on": "implement [feature] for",
    "address": "resolve [issue] in",
    "review": "audit [component] of",
  };
  return replacements[vagueVerb.toLowerCase()] ?? vagueVerb;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
