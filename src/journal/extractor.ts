/**
 * Decision extractor — pattern-based extraction from agent outputs.
 * No LLM calls. Only extracts from Tech Lead, RFC Author, and Coordinator.
 */

import { randomUUID } from "node:crypto";
import type { Decision } from "./types.js";

/** Agent roles whose outputs are worth extracting decisions from. */
const DECISION_AGENT_ROLES = new Set([
  "tech_lead",
  "rfc_author",
  "coordinator",
  "system_designer",
  "planner",
]);

/** Roles to skip — too implementation-specific and noisy. */
const SKIP_ROLES = new Set([
  "worker_bot",
  "qa_reviewer",
  "software_engineer",
]);

interface DecisionMatch {
  decision: string;
  reasoning: string;
}

interface DecisionPattern {
  regex: RegExp;
  extract: (match: RegExpMatchArray) => DecisionMatch;
}

const DECISION_PATTERNS: DecisionPattern[] = [
  {
    regex: /(?:we should|should) use (.+?) instead of (.+?)(?:\.|,|$)/i,
    extract: (m) => ({
      decision: `Use ${m[1]!.trim()} instead of ${m[2]!.trim()}`,
      reasoning: m[0]!.trim(),
    }),
  },
  {
    regex: /decided to (.+?)(?:\.|,|\sbecause|$)/i,
    extract: (m) => ({
      decision: m[1]!.trim(),
      reasoning: m[0]!.trim(),
    }),
  },
  {
    regex: /recommend(?:ing)?\s+(.+?)\s+because\s+(.+?)(?:\.|$)/i,
    extract: (m) => ({
      decision: m[1]!.trim(),
      reasoning: m[2]!.trim(),
    }),
  },
  {
    regex: /choosing (.+?) over (.+?)(?:\.|,|\sbecause|$)/i,
    extract: (m) => ({
      decision: `Choose ${m[1]!.trim()} over ${m[2]!.trim()}`,
      reasoning: m[0]!.trim(),
    }),
  },
  {
    regex: /going with (.+?)(?:\.|,|\sbecause|\sfor|$)/i,
    extract: (m) => ({
      decision: m[1]!.trim(),
      reasoning: m[0]!.trim(),
    }),
  },
  {
    regex: /(?:will |let's |we'll )use (.+?) for (.+?)(?:\.|,|$)/i,
    extract: (m) => ({
      decision: `Use ${m[1]!.trim()} for ${m[2]!.trim()}`,
      reasoning: m[0]!.trim(),
    }),
  },
  {
    regex: /avoid (.+?) because (.+?)(?:\.|$)/i,
    extract: (m) => ({
      decision: `Avoid ${m[1]!.trim()}`,
      reasoning: m[2]!.trim(),
    }),
  },
  {
    regex: /switch(?:ed|ing)?\s+(?:from\s+(.+?)\s+)?to\s+(.+?)(?:\.|,|$)/i,
    extract: (m) => ({
      decision: m[1]
        ? `Switch from ${m[1].trim()} to ${m[2]!.trim()}`
        : `Switch to ${m[2]!.trim()}`,
      reasoning: m[0]!.trim(),
    }),
  },
];

/** Extract a short topic from the decision text. */
function extractTopic(decision: string): string {
  // Remove common prefixes
  const cleaned = decision
    .replace(/^(Use|Choose|Avoid|Switch to|Switch from)\s+/i, "")
    .trim();
  // Take first few words as topic
  const words = cleaned.split(/\s+/).slice(0, 4);
  return words.join(" ");
}

/** Extract keyword tags from decision + reasoning. */
function extractTags(decision: string, reasoning: string): string[] {
  const text = `${decision} ${reasoning}`.toLowerCase();
  const tags = new Set<string>();

  const techKeywords = [
    "oauth", "auth", "jwt", "token", "api", "rest", "graphql", "grpc",
    "database", "sql", "nosql", "redis", "cache", "caching",
    "docker", "kubernetes", "k8s", "deploy", "ci", "cd",
    "react", "vue", "angular", "frontend", "backend",
    "typescript", "javascript", "python", "rust", "go",
    "testing", "test", "tdd", "e2e", "unit",
    "security", "encryption", "ssl", "tls", "https",
    "websocket", "sse", "polling", "streaming",
    "microservice", "monolith", "serverless", "lambda",
    "queue", "kafka", "rabbitmq", "pubsub",
    "monitoring", "logging", "observability", "metrics",
    "performance", "optimization", "scalability",
    "architecture", "design", "pattern", "refactor",
    "migration", "schema", "orm", "prisma",
    "session", "cookie", "storage", "state",
    "pkce", "implicit", "authorization",
  ];

  for (const kw of techKeywords) {
    if (text.includes(kw)) {
      tags.add(kw);
    }
  }

  return [...tags].slice(0, 8);
}

export interface ExtractionInput {
  agentRole: string;
  agentOutput: string;
  taskId: string;
  sessionId: string;
  runIndex: number;
  goalContext: string;
  confidence?: number;
}

/**
 * Extract decisions from agent output using pattern matching.
 * Returns empty array if no patterns match or agent role is not extractable.
 */
export function extractDecisions(input: ExtractionInput): Decision[] {
  // Only extract from specific agent roles
  if (SKIP_ROLES.has(input.agentRole)) return [];
  if (!DECISION_AGENT_ROLES.has(input.agentRole)) return [];

  const output = input.agentOutput;
  if (!output || output.length < 20) return [];

  const decisions: Decision[] = [];
  const seenDecisions = new Set<string>();

  for (const pattern of DECISION_PATTERNS) {
    const match = output.match(pattern.regex);
    if (!match) continue;

    const { decision, reasoning } = pattern.extract(match);
    if (!decision || decision.length < 5) continue;

    // Deduplicate within same extraction
    const key = decision.toLowerCase().trim();
    if (seenDecisions.has(key)) continue;
    seenDecisions.add(key);

    const topic = extractTopic(decision);
    const tags = extractTags(decision, reasoning);

    decisions.push({
      id: randomUUID(),
      sessionId: input.sessionId,
      runIndex: input.runIndex,
      capturedAt: Date.now(),
      topic,
      decision,
      reasoning,
      recommendedBy: input.agentRole,
      confidence: input.confidence ?? 0,
      taskId: input.taskId,
      goalContext: input.goalContext,
      tags,
      embedding: [],
      status: "active",
    });
  }

  return decisions;
}
