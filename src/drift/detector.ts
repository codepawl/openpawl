/**
 * Drift detector — three-pass detection algorithm.
 * Pass 1: Keyword overlap between goal and decision tags
 * Pass 2: Text similarity (Jaccard on words)
 * Pass 3: Contradiction check using antonym patterns
 * No LLM calls.
 */

import { randomUUID } from "node:crypto";
import type { Decision } from "../journal/types.js";
import type { DriftResult, DriftConflict, ConflictType, DriftSeverity } from "./types.js";
import { detectContradiction } from "../journal/supersession.js";
import { extractGoalFragment } from "./fragment-extractor.js";
import { generateExplanation } from "./explainer.js";
import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "../debug/logger.js";

/** Preference patterns: "prefer X over Y", "chose X instead of Y" */
const PREFERENCE_PATTERNS = [
  /\bprefer\b.*\bover\b/i,
  /\bchose\b.*\binstead\b/i,
  /\brather\b.*\bthan\b/i,
  /\bover\b.*\bfor\b/i,
];

/** Extract keywords from text matching the tech keyword set used in journal extractor. */
function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
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
  return techKeywords.filter((kw) => lower.includes(kw));
}

/** Word-level Jaccard similarity. */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(
    a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? shared / union : 0;
}

/** Check if goal text has a preference conflict with decision. */
function hasPreferenceConflict(goal: string, decision: string): boolean {
  // Decision says "prefer X over Y" and goal mentions Y
  for (const pattern of PREFERENCE_PATTERNS) {
    if (pattern.test(decision)) {
      // Extract the non-preferred term (after "over"/"instead"/"than")
      const overMatch = decision.match(/\bover\s+(\w+)/i)
        ?? decision.match(/\binstead\s+of\s+(\w+)/i)
        ?? decision.match(/\bthan\s+(\w+)/i);
      if (overMatch) {
        const rejected = overMatch[1]!.toLowerCase();
        if (goal.toLowerCase().includes(rejected)) return true;
      }
    }
  }
  return false;
}

/** Determine the type of conflict between goal text and a decision. */
function classifyConflict(goal: string, decision: Decision): ConflictType {
  // Direct: antonym patterns (use vs avoid, add vs remove, etc.)
  if (detectContradiction(goal, decision.decision)) return "direct";

  // Indirect: preference patterns
  if (hasPreferenceConflict(goal, decision.decision)) return "indirect";

  // Ambiguous: topic overlap but no clear contradiction
  return "ambiguous";
}

/** Determine severity from conflict list. */
function computeSeverity(conflicts: DriftConflict[]): DriftSeverity {
  if (conflicts.length === 0) return "none";
  if (conflicts.some((c) => c.conflictType === "direct")) return "hard";
  if (conflicts.length >= 2) return "hard";
  return "soft";
}

export interface DetectorOptions {
  /** Max age in days for non-permanent decisions. Default 90. */
  maxAgeDays?: number;
}

/**
 * Run three-pass drift detection against stored decisions.
 * Returns DriftResult with all conflicts found.
 */
export function detectDrift(
  goal: string,
  decisions: Decision[],
  options: DetectorOptions = {},
): DriftResult {
  const maxAgeMs = (options.maxAgeDays ?? 90) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Filter to active decisions within age window (or permanent)
  const candidates = decisions.filter((d) => {
    if (d.status !== "active") return false;
    const isPermanent = (d as Decision & { permanent?: boolean }).permanent === true;
    if (isPermanent) return true;
    return (now - d.capturedAt) <= maxAgeMs;
  });

  if (candidates.length === 0) {
    return { hasDrift: false, severity: "none", conflicts: [], checkedAt: now };
  }

  const goalKeywords = extractKeywords(goal);
  const seen = new Set<string>();
  const conflicts: DriftConflict[] = [];

  // Pass 1: Keyword overlap
  for (const dec of candidates) {
    const overlap = dec.tags.filter((t) => goalKeywords.includes(t));
    if (overlap.length === 0) continue;

    const conflictType = classifyConflict(goal, dec);
    const fragment = extractGoalFragment(goal, dec.tags);
    const explanation = generateExplanation(
      conflictType, fragment, dec.decision, dec.reasoning, dec.topic,
    );
    const similarity = overlap.length / Math.max(goalKeywords.length, dec.tags.length, 1);

    seen.add(dec.id);
    conflicts.push({
      conflictId: randomUUID(),
      goalFragment: fragment,
      decision: dec,
      similarityScore: similarity,
      conflictType,
      explanation,
    });
  }

  // Pass 2: Text similarity for decisions not caught by keyword overlap
  for (const dec of candidates) {
    if (seen.has(dec.id)) continue;
    const sim = textSimilarity(goal, `${dec.topic} ${dec.decision} ${dec.reasoning}`);
    if (sim < 0.15) continue;

    const conflictType = classifyConflict(goal, dec);
    // Only include if there's actual conflict signal
    if (conflictType === "ambiguous" && sim < 0.25) continue;

    const fragment = extractGoalFragment(goal, dec.tags);
    const explanation = generateExplanation(
      conflictType, fragment, dec.decision, dec.reasoning, dec.topic,
    );

    seen.add(dec.id);
    conflicts.push({
      conflictId: randomUUID(),
      goalFragment: fragment,
      decision: dec,
      similarityScore: sim,
      conflictType,
      explanation,
    });
  }

  const severity = computeSeverity(conflicts);

  const result: DriftResult = {
    hasDrift: conflicts.length > 0,
    severity,
    conflicts,
    checkedAt: now,
  };

  if (isDebugEnabled()) {
    debugLog(result.hasDrift ? "warn" : "info", "memory", "drift:check", {
      data: {
        goal: truncateStr(goal, TRUNCATION.goalText),
        candidateDecisions: candidates.length,
        conflictCount: conflicts.length,
        severity,
        conflicts: conflicts.slice(0, 3).map((c) => ({
          type: c.conflictType,
          decision: truncateStr(c.decision?.decision ?? "", TRUNCATION.driftConflict),
          similarity: Math.round(c.similarityScore * 100) / 100,
        })),
      },
    });
  }

  return result;
}
