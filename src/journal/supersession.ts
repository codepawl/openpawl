/**
 * Supersession detection — finds when a new decision contradicts an old one.
 * Rule-based contradiction detection using negation/antonym patterns. No LLM calls.
 */

import type { Decision, SupersessionAlert } from "./types.js";
import type { DecisionStore } from "./store.js";

/** Contradiction pairs: if decision A matches left and B matches right, they contradict. */
const CONTRADICTION_PAIRS: Array<[RegExp, RegExp]> = [
  [/\buse\b/i, /\bavoid\b/i],
  [/\bprefer\b/i, /\bdon'?t use\b/i],
  [/\bchoose\b/i, /\breject\b/i],
  [/\benable\b/i, /\bdisable\b/i],
  [/\binclude\b/i, /\bexclude\b/i],
  [/\ballow\b/i, /\bblock\b/i],
  [/\badd\b/i, /\bremove\b/i],
  [/\bswitch to\b/i, /\bswitch from\b/i],
  [/\binstead of\b/i, /\bgoing with\b/i],
];

/**
 * Compute keyword-based similarity between two decision texts.
 * Returns 0..1 score based on shared keywords.
 */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? shared / union : 0;
}

/** Check if two decision texts show a contradiction pattern. */
export function detectContradiction(oldDecision: string, newDecision: string): boolean {
  for (const [patternA, patternB] of CONTRADICTION_PAIRS) {
    // Old matches A and new matches B
    if (patternA.test(oldDecision) && patternB.test(newDecision)) return true;
    // Old matches B and new matches A
    if (patternB.test(oldDecision) && patternA.test(newDecision)) return true;
  }
  return false;
}

/**
 * Check a newly captured decision against existing decisions for supersession.
 * Returns alerts for any superseded decisions.
 */
export async function checkSupersession(
  newDecision: Decision,
  store: DecisionStore,
): Promise<SupersessionAlert[]> {
  const alerts: SupersessionAlert[] = [];

  const existing = await store.getAll();
  const active = existing.filter(
    (d) => d.status === "active" && d.id !== newDecision.id,
  );

  for (const old of active) {
    // Check topic similarity — must be about the same subject
    const topicSim = textSimilarity(
      `${old.topic} ${old.decision}`,
      `${newDecision.topic} ${newDecision.decision}`,
    );

    if (topicSim < 0.3) continue;

    // Check for contradiction
    const contradicts = detectContradiction(old.decision, newDecision.decision);
    if (!contradicts) continue;

    // Supersede the old decision
    await store.supersede(old.id, newDecision.id);

    alerts.push({
      oldDecision: { ...old, status: "superseded", supersededBy: newDecision.id },
      newDecision,
      detectedAt: Date.now(),
    });
  }

  return alerts;
}
