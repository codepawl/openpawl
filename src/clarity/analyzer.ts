/**
 * Goal clarity analyzer — pattern-based detection of ambiguous goals.
 * No LLM calls. Completes in under 500ms.
 */

import type { ClarityResult, ClarityIssue, ClarityIssueType } from "./types.js";
import { detectBreadth } from "./breadth-analyzer.js";
import { generateSuggestions } from "./suggester.js";

export const VAGUE_VERBS = [
  "improve", "fix", "update", "enhance", "handle", "deal with",
  "make better", "optimize", "clean up", "refactor", "revisit",
  "look at", "work on", "address", "review",
];

export const UNSPECIFIED_NOUNS = [
  "the api", "the system", "the app", "the code", "the database",
  "it", "this", "that", "everything", "stuff", "things",
];

export const SUCCESS_CRITERIA_SIGNALS = [
  "so that", "until", "when", "target", "goal is", "aim",
  "%", "ms", "seconds", "requests", "users", "reduce", "increase",
];

const AMBIGUOUS_CONSTRAINTS = [
  { pattern: /make .{0,30}fast(?:er)?/i, label: "faster than what?" },
  { pattern: /make .{0,30}bett?er/i, label: "better in what way?" },
  { pattern: /make .{0,30}simpl(?:e|er)/i, label: "simpler how?" },
  { pattern: /more (?:efficient|scalable|robust|reliable)/i, label: "compared to what baseline?" },
];

const CONFLICTING_PAIRS: Array<[RegExp, RegExp, string]> = [
  [/\bsimple\b/i, /\bcomprehensive\b/i, '"simple" and "comprehensive" may conflict'],
  [/\bquick\b/i, /\bthorough\b/i, '"quick" and "thorough" may conflict'],
  [/\bminimal\b/i, /\bcomplete\b/i, '"minimal" and "complete" may conflict'],
  [/\blightweight\b/i, /\bfull[- ]featured\b/i, '"lightweight" and "full-featured" may conflict'],
];

function findVagueVerbs(goal: string): ClarityIssue[] {
  const lower = goal.toLowerCase();
  const issues: ClarityIssue[] = [];
  for (const verb of VAGUE_VERBS) {
    const regex = new RegExp(`\\b${verb.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (regex.test(lower)) {
      issues.push({
        type: "vague_verb",
        fragment: verb,
        question: `"${capitalize(verb)}" is vague — what specifically do you mean?`,
        severity: "advisory",
      });
    }
  }
  return issues;
}

function findUnspecifiedNouns(goal: string): ClarityIssue[] {
  const lower = goal.toLowerCase();
  const issues: ClarityIssue[] = [];
  for (const noun of UNSPECIFIED_NOUNS) {
    const regex = new RegExp(`\\b${noun.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (regex.test(lower)) {
      issues.push({
        type: "unspecified_noun",
        fragment: noun,
        question: `"${noun}" is unspecified — which one exactly?`,
        severity: "advisory",
      });
    }
  }
  return issues;
}

function checkSuccessCriteria(goal: string): ClarityIssue | null {
  const lower = goal.toLowerCase();
  for (const signal of SUCCESS_CRITERIA_SIGNALS) {
    if (lower.includes(signal.toLowerCase())) return null;
  }
  return {
    type: "missing_success_criteria",
    fragment: goal,
    question: "No success criteria — how will you know it's done? (add a measurable outcome)",
    severity: "advisory",
  };
}

function checkAmbiguousConstraints(goal: string): ClarityIssue[] {
  const issues: ClarityIssue[] = [];
  for (const { pattern, label } of AMBIGUOUS_CONSTRAINTS) {
    const match = goal.match(pattern);
    if (match) {
      issues.push({
        type: "ambiguous_constraint",
        fragment: match[0],
        question: `"${match[0]}" is ambiguous — ${label}`,
        severity: "advisory",
      });
    }
  }
  return issues;
}

function checkConflictingRequirements(goal: string): ClarityIssue[] {
  const issues: ClarityIssue[] = [];
  for (const [a, b, desc] of CONFLICTING_PAIRS) {
    if (a.test(goal) && b.test(goal)) {
      issues.push({
        type: "conflicting_requirements",
        fragment: goal,
        question: `${desc} — which takes priority?`,
        severity: "advisory",
      });
    }
  }
  return issues;
}

function applySeverityRules(issues: ClarityIssue[]): void {
  const hasVague = issues.some((i) => i.type === "vague_verb");
  const hasUnspecified = issues.some((i) => i.type === "unspecified_noun");
  const hasBroad = issues.some((i) => i.type === "too_broad");

  // vague_verb + unspecified_noun together → blocking
  if (hasVague && hasUnspecified) {
    for (const issue of issues) {
      if (issue.type === "vague_verb" || issue.type === "unspecified_noun") {
        issue.severity = "blocking";
      }
    }
  }

  // too_broad is always blocking
  if (hasBroad) {
    for (const issue of issues) {
      if (issue.type === "too_broad") {
        issue.severity = "blocking";
      }
    }
  }
}

export function hasSuccessCriteria(goal: string): boolean {
  const lower = goal.toLowerCase();
  return SUCCESS_CRITERIA_SIGNALS.some((s) => lower.includes(s.toLowerCase()));
}

export function hasMetrics(goal: string): boolean {
  return /\d+\s*(%|ms|seconds?|sec|req|requests?|users?|rps|tps|mb|gb|kb)/i.test(goal);
}

export function calculateClarityScore(goal: string, issues: ClarityIssue[]): number {
  let score = 1.0;
  for (const issue of issues) {
    if (issue.severity === "blocking") score -= 0.35;
    if (issue.severity === "advisory") score -= 0.15;
  }
  if (hasSuccessCriteria(goal)) score += 0.1;
  if (hasMetrics(goal)) score += 0.1;
  return Math.max(0, Math.min(1, score));
}

export function analyzeClarity(
  goal: string,
  options: { ignoredTypes?: ClarityIssueType[] } = {},
): ClarityResult {
  const { ignoredTypes = [] } = options;

  if (!goal || !goal.trim()) {
    return {
      isClear: false,
      score: 0,
      issues: [{
        type: "missing_scope",
        fragment: "",
        question: "Goal is empty — what do you want to accomplish?",
        severity: "blocking",
      }],
      suggestions: [],
      checkedAt: Date.now(),
    };
  }

  let allIssues: ClarityIssue[] = [
    ...findVagueVerbs(goal),
    ...findUnspecifiedNouns(goal),
    ...checkAmbiguousConstraints(goal),
    ...checkConflictingRequirements(goal),
  ];

  const successIssue = checkSuccessCriteria(goal);
  if (successIssue) allIssues.push(successIssue);

  const breadthResult = detectBreadth(goal);
  if (breadthResult.isTooWide) {
    allIssues.push({
      type: "too_broad",
      fragment: goal,
      question: `Goal spans ${breadthResult.domains.length} domains: ${breadthResult.domains.join(", ")}. Consider splitting into focused goals.`,
      severity: "blocking",
    });
  }

  applySeverityRules(allIssues);

  // Filter out ignored types
  allIssues = allIssues.filter((i) => !ignoredTypes.includes(i.type));

  const score = calculateClarityScore(goal, allIssues);
  const isClear = score >= 0.8;

  const suggestions = isClear ? [] : generateSuggestions(goal, allIssues);

  return {
    isClear,
    score,
    issues: allIssues,
    suggestions,
    checkedAt: Date.now(),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
