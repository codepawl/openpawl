/**
 * Keyword-based rules for agent inclusion in autonomous team composition.
 * Pattern follows src/agents/profiles/classifier.ts — keyword arrays scored by hit count.
 */

import type { AgentRole, AnyAgentRole } from "./types.js";

export interface AgentInclusionRule {
  role: AnyAgentRole;
  required: boolean;
  keywords: string[];
  negativeKeywords: string[];
  description: string;
}

export const AGENT_INCLUSION_RULES: AgentInclusionRule[] = [
  {
    role: "sprint_planning",
    required: false,
    keywords: [
      "complex", "multiple", "sprint", "plan", "milestone",
      "phase", "stages", "roadmap", "multi-step", "breakdown",
    ],
    negativeKeywords: ["simple", "quick", "single", "trivial", "one-off"],
    description: "Sprint planning for multi-phase or complex goals",
  },
  {
    role: "system_design",
    required: false,
    keywords: [
      "architect", "design", "system", "infrastructure", "database",
      "api", "microservice", "scalab", "component", "integration",
    ],
    negativeKeywords: ["content", "copy", "writing", "editorial"],
    description: "System design for architecture and infrastructure goals",
  },
  {
    role: "rfc_phase",
    required: false,
    keywords: [
      "complex", "architecture", "critical", "security", "migration",
      "refactor", "overhaul", "redesign", "rfc", "proposal",
    ],
    negativeKeywords: ["simple", "quick", "prototype", "mvp"],
    description: "RFC phase for critical or large-scale changes",
  },
  {
    role: "post_mortem",
    required: false,
    keywords: [],
    negativeKeywords: [],
    description: "Post-mortem analysis (included for multi-run sessions)",
  },
  {
    role: "retrospective",
    required: false,
    keywords: [],
    negativeKeywords: [],
    description: "Retrospective review (included for multi-run sessions)",
  },
];

export interface InclusionScore {
  score: number;
  matchedKeywords: string[];
}

/**
 * Score a goal against an agent's inclusion rule.
 * Returns net score (positive hits minus negative hits) and matched keywords.
 */
export function scoreAgentInclusion(
  rule: AgentInclusionRule,
  goalLower: string,
): InclusionScore {
  const matchedKeywords: string[] = [];
  let score = 0;

  for (const kw of rule.keywords) {
    if (goalLower.includes(kw)) {
      score++;
      matchedKeywords.push(kw);
    }
  }

  for (const kw of rule.negativeKeywords) {
    if (goalLower.includes(kw)) {
      score--;
    }
  }

  return { score, matchedKeywords };
}

export interface InclusionResult {
  include: boolean;
  confidence: number;
  reason: string;
}

/**
 * Determine whether an agent should be included based on goal keywords.
 * post_mortem and retrospective use runCount instead of keywords.
 */
export function shouldIncludeAgent(
  rule: AgentInclusionRule,
  goalLower: string,
  options?: { runCount?: number },
): InclusionResult {
  // Post-graph agents: include only for multi-run sessions
  if (rule.role === "post_mortem" || rule.role === "retrospective") {
    const runCount = options?.runCount ?? 1;
    const include = runCount > 1;
    return {
      include,
      confidence: include ? 0.9 : 0.1,
      reason: include
        ? `Multi-run session (${runCount} runs) benefits from ${rule.role.replace("_", " ")}`
        : `Single-run session — ${rule.role.replace("_", " ")} not needed`,
    };
  }

  const { score, matchedKeywords } = scoreAgentInclusion(rule, goalLower);

  if (score >= 1) {
    // Confidence scales with keyword hits, capped at 0.95
    const confidence = Math.min(0.5 + score * 0.15, 0.95);
    return {
      include: true,
      confidence,
      reason: `Goal matches: ${matchedKeywords.join(", ")}`,
    };
  }

  return {
    include: false,
    confidence: 0.7,
    reason: score < 0
      ? `Negative keywords outweigh matches for ${rule.description.toLowerCase()}`
      : `No keyword matches for ${rule.description.toLowerCase()}`,
  };
}
