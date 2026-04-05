/**
 * Cost + latency aware model selection.
 */

export interface ModelSelection {
  provider: string;
  model: string;
  reason: string;
  estimatedCost: number;
  estimatedLatencyMs: number;
}

export interface SmartRouterCandidate {
  provider: string;
  model: string;
  healthy: boolean;
  avgLatencyMs: number;
  costPerMToken: number;
}

export class SmartModelRouter {
  selectModel(
    candidates: SmartRouterCandidate[],
    request: {
      preferSpeed?: boolean;
      preferCost?: boolean;
      maxLatencyMs?: number;
    },
  ): ModelSelection | null {
    let available = candidates.filter((c) => c.healthy);

    if (request.maxLatencyMs) {
      available = available.filter((c) => c.avgLatencyMs <= request.maxLatencyMs!);
    }

    if (available.length === 0) return null;

    // Score each candidate
    const costWeight = request.preferCost ? 0.7 : request.preferSpeed ? 0.3 : 0.5;
    const latencyWeight = 1 - costWeight;

    const maxCost = Math.max(...available.map((c) => c.costPerMToken), 1);
    const maxLatency = Math.max(...available.map((c) => c.avgLatencyMs), 1);

    let best: SmartRouterCandidate | null = null;
    let bestScore = -Infinity;

    for (const c of available) {
      // Lower cost/latency = higher score (invert)
      const costScore = 1 - c.costPerMToken / maxCost;
      const latencyScore = 1 - c.avgLatencyMs / maxLatency;
      const score = costWeight * costScore + latencyWeight * latencyScore;

      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (!best) return null;

    const reason = request.preferCost ? "cheapest available"
      : request.preferSpeed ? "fastest healthy"
      : "balanced cost/latency";

    return {
      provider: best.provider,
      model: best.model,
      reason,
      estimatedCost: best.costPerMToken,
      estimatedLatencyMs: best.avgLatencyMs,
    };
  }
}
