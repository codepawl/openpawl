/**
 * Drift supervisor at the phase boundary per spec §5.5.
 *
 * After the Facilitator synthesis succeeds, score the
 * MeetingNotesArtifact.markdown against the original goal. The score
 * is `1 - jaccard_word_similarity(goal, markdown)` — high score = high
 * drift. The Jaccard helper is borrowed conceptually from the v0.3
 * `src/drift/` module (which scores against a typed Decision[], not
 * free markdown). This adapter keeps the helper inline so the crew
 * runtime depends only on a small, vetted slice rather than the
 * journal-typed surface; it also lets the supervisor compute a numeric
 * score while the existing module continues to drive solo's
 * decision-journal flow.
 *
 * Three buckets:
 *   - score < drift_warn_threshold (default 0.5)  → "ok"
 *   - warn ≤ score < halt   (default 0.5..0.75)   → "warn"
 *   - score ≥ drift_halt_threshold (default 0.75) → "halt"
 *
 * The supervisor never throws on its own scoring math, but if a caller-
 * supplied scorer throws, we degrade to "ok" + debug warning so a
 * malfunctioning drift module cannot abort a crew run.
 */

import { debugLog } from "../debug/logger.js";
import type { PhaseSummaryArtifact } from "./artifacts/index.js";

export const DEFAULT_DRIFT_WARN_THRESHOLD = 0.5;
export const DEFAULT_DRIFT_HALT_THRESHOLD = 0.75;

export type DriftDecision = "ok" | "warn" | "halt";

export interface DriftingDecision {
  description: string;
  decided_in_phase_id: string;
  drift_distance: number;
}

export interface DriftCheckResult {
  score: number;
  decision: DriftDecision;
  drifting_decisions: DriftingDecision[];
}

export type DriftScorer = (goal: string, markdown: string) => number;

/**
 * Default scorer — *one-sided* goal-coverage: how many of the goal's
 * meaningful tokens (>2 chars) appear in the markdown? Score is
 * `1 - coverage`. We use one-sided coverage rather than Jaccard
 * because the meeting markdown is necessarily much longer than the
 * goal text, and Jaccard would systematically inflate the drift score
 * for on-topic phases just from length asymmetry.
 *
 * Same conceptual basis as `src/drift/detector.ts`'s `textSimilarity`,
 * kept inline so this module has no journal-types dependency.
 */
export function defaultDriftScorer(goal: string, markdown: string): number {
  const tokenize = (text: string): Set<string> => {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
    return new Set(words);
  };
  const goalTokens = tokenize(goal);
  const markdownTokens = tokenize(markdown);
  if (goalTokens.size === 0 || markdownTokens.size === 0) return 1;
  let shared = 0;
  for (const w of goalTokens) if (markdownTokens.has(w)) shared += 1;
  const coverage = shared / goalTokens.size;
  return Math.max(0, Math.min(1, 1 - coverage));
}

export interface CheckDriftArgs {
  goal: string;
  meeting_notes_markdown: string;
  /** Phase the meeting just covered. Used to label drifting_decisions. */
  prev_phase_id: string;
  /** Recent phase summaries to source key_decisions from (most-recent first). */
  recent_phase_summaries?: PhaseSummaryArtifact[];
  drift_warn_threshold?: number;
  drift_halt_threshold?: number;
  /** Inject a different scorer (e.g. for tests, or to swap in a smarter one later). */
  scorer?: DriftScorer;
}

export function checkDriftAtPhaseBoundary(
  args: CheckDriftArgs,
): DriftCheckResult {
  const warn = args.drift_warn_threshold ?? DEFAULT_DRIFT_WARN_THRESHOLD;
  const halt = args.drift_halt_threshold ?? DEFAULT_DRIFT_HALT_THRESHOLD;
  const scorer = args.scorer ?? defaultDriftScorer;

  let score: number;
  try {
    const raw = scorer(args.goal, args.meeting_notes_markdown);
    score = Number.isFinite(raw)
      ? Math.max(0, Math.min(1, raw))
      : 0;
    if (!Number.isFinite(raw)) {
      debugLog("warn", "crew", "drift:scorer_returned_non_finite", {
        data: { raw, prev_phase_id: args.prev_phase_id },
      });
    }
  } catch (err) {
    debugLog("warn", "crew", "drift:scorer_threw", {
      data: { prev_phase_id: args.prev_phase_id },
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      score: 0,
      decision: "ok",
      drifting_decisions: [],
    };
  }

  let decision: DriftDecision;
  if (score >= halt) decision = "halt";
  else if (score >= warn) decision = "warn";
  else decision = "ok";

  const drifting_decisions =
    decision === "ok"
      ? []
      : extractDriftingDecisions(args.recent_phase_summaries ?? [], args.goal, scorer);

  if (decision === "warn") {
    debugLog("warn", "crew", "crew:drift_warn", {
      data: {
        score,
        prev_phase_id: args.prev_phase_id,
        drifting_decision_count: drifting_decisions.length,
      },
    });
  } else if (decision === "halt") {
    debugLog("error", "crew", "crew:drift_halt", {
      data: {
        score,
        prev_phase_id: args.prev_phase_id,
        drifting_decision_count: drifting_decisions.length,
      },
    });
  }

  return { score, decision, drifting_decisions };
}

/**
 * Pull `key_decisions` from the most-recent (up to 3) PhaseSummary
 * artifacts and rank them by their own drift distance from the goal.
 *
 * Note: phase-executor lands `key_decisions: []` for now (the meeting
 * synthesis overlay PR will populate it). When the field is empty we
 * return [], not synthetic data — the caller's re-anchor prompt then
 * shows just the original goal.
 */
function extractDriftingDecisions(
  recentSummaries: PhaseSummaryArtifact[],
  goal: string,
  scorer: DriftScorer,
): DriftingDecision[] {
  const candidates: DriftingDecision[] = [];
  for (const summary of recentSummaries.slice(0, 3)) {
    const decisions = summary.payload.key_decisions ?? [];
    for (const description of decisions) {
      try {
        const distance = scorer(goal, description);
        if (Number.isFinite(distance)) {
          candidates.push({
            description,
            decided_in_phase_id: summary.payload.phase_id,
            drift_distance: Math.max(0, Math.min(1, distance)),
          });
        }
      } catch {
        // Same defensive posture as the top-level scorer call.
      }
    }
  }
  return candidates
    .sort((a, b) => b.drift_distance - a.drift_distance)
    .slice(0, 3);
}
