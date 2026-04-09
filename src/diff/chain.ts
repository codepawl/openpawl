/**
 * Multi-run diff chain — produces a chain of RunDiffs with trend detection.
 */

import type { DiffChain, OverallTrend, RunDiff, RunSnapshot, Trend } from "./types.js";
import { computeRunDiff } from "./engine.js";

const DEFAULT_PLATEAU_THRESHOLD = 0.02;

export interface ChainOptions {
  /** Confidence delta below which a plateau is detected. Default: 0.02. */
  plateauThreshold?: number;
}

/** Build a DiffChain from an ordered array of RunSnapshots. */
export function buildDiffChain(
  snapshots: RunSnapshot[],
  options: ChainOptions = {},
): DiffChain {
  if (snapshots.length < 2) {
    return {
      sessionId: snapshots[0]?.sessionId ?? "",
      totalRuns: snapshots.length,
      runDiffs: [],
      overallTrend: {
        confidenceTrend: "stable",
        learningEfficiency: 0,
        plateauDetected: false,
      },
    };
  }

  const threshold = options.plateauThreshold ?? DEFAULT_PLATEAU_THRESHOLD;

  // Sort by runIndex to ensure order
  const sorted = [...snapshots].sort((a, b) => a.runIndex - b.runIndex);

  const runDiffs: RunDiff[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    runDiffs.push(computeRunDiff(sorted[i], sorted[i + 1]));
  }

  const overallTrend = computeOverallTrend(sorted, runDiffs, threshold);

  return {
    sessionId: sorted[0].sessionId,
    totalRuns: sorted.length,
    runDiffs,
    overallTrend,
  };
}

/** Build a DiffChain for a specific pair of runs within a session. */
export function buildPairDiff(from: RunSnapshot, to: RunSnapshot): DiffChain {
  const diff = computeRunDiff(from, to);
  return {
    sessionId: from.sessionId,
    totalRuns: 2,
    runDiffs: [diff],
    overallTrend: {
      confidenceTrend: classifyTrend(to.averageConfidence - from.averageConfidence),
      learningEfficiency: to.averageConfidence - from.averageConfidence,
      plateauDetected: false,
    },
  };
}

function computeOverallTrend(
  snapshots: RunSnapshot[],
  diffs: RunDiff[],
  threshold: number,
): OverallTrend {
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];

  const totalConfDelta = last.averageConfidence - first.averageConfidence;
  const numRuns = snapshots.length;

  const learningEfficiency = numRuns > 1 ? totalConfDelta / (numRuns - 1) : 0;

  // Plateau: check last 2 runs
  let plateauDetected = false;
  let plateauMessage: string | undefined;

  if (diffs.length >= 2) {
    const lastDiff = diffs[diffs.length - 1];
    const prevDiff = diffs[diffs.length - 2];
    if (
      Math.abs(lastDiff.metricDiffs.averageConfidenceDelta) < threshold &&
      Math.abs(prevDiff.metricDiffs.averageConfidenceDelta) < threshold
    ) {
      plateauDetected = true;
      const lastRun = last.runIndex;
      plateauMessage =
        `Plateau detected after run ${lastRun} — confidence improvement < ${threshold} ` +
        `between runs ${lastRun - 1} and ${lastRun}. ` +
        `Consider: adjusting goal decomposition, adding more context, or changing team composition.`;
    }
  } else if (diffs.length === 1) {
    if (Math.abs(diffs[0].metricDiffs.averageConfidenceDelta) < threshold) {
      plateauDetected = true;
      plateauMessage =
        `Plateau detected — confidence improvement < ${threshold} between runs. ` +
        `Consider: adjusting goal decomposition, adding more context, or changing team composition.`;
    }
  }

  return {
    confidenceTrend: classifyTrend(totalConfDelta),
    learningEfficiency: Math.round(learningEfficiency * 1000) / 1000,
    plateauDetected,
    plateauMessage,
  };
}

function classifyTrend(delta: number): Trend {
  if (delta > 0.02) return "improving";
  if (delta < -0.02) return "degrading";
  return "stable";
}

