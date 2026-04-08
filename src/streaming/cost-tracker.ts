/**
 * Real-time token usage tracking per session.
 * Tracks input/output tokens by provider and agent. No dollar cost estimation.
 */

import { EventEmitter } from "node:events";
import type { CostSummary, CostUpdateEvent } from "./types.js";

/** @deprecated No-op — dollar cost estimation removed. Returns 0. */
export function calculateCost(_model: string, _inputTokens: number, _outputTokens: number): number {
  return 0;
}

export class CostTracker extends EventEmitter {
  private sessions = new Map<string, CostSummary>();

  recordUsage(
    sessionId: string,
    agentId: string,
    provider: string,
    _model: string,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const summary = this.getOrCreate(sessionId);

    summary.totalInputTokens += inputTokens;
    summary.totalOutputTokens += outputTokens;

    // By provider
    const prov = summary.byProvider[provider] ?? { tokens: 0, costUSD: 0 };
    prov.tokens += inputTokens + outputTokens;
    summary.byProvider[provider] = prov;

    // By agent
    const agent = summary.byAgent[agentId] ?? { tokens: 0, costUSD: 0 };
    agent.tokens += inputTokens + outputTokens;
    summary.byAgent[agentId] = agent;

    const event: CostUpdateEvent = {
      type: "cost:update",
      sessionId,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      totalCostUSD: 0,
      timestamp: Date.now(),
    };
    this.emit("cost:update", event);
  }

  getSessionCost(sessionId: string): CostSummary {
    return this.getOrCreate(sessionId);
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private getOrCreate(sessionId: string): CostSummary {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { totalInputTokens: 0, totalOutputTokens: 0, totalCostUSD: 0, byProvider: {}, byAgent: {} };
      this.sessions.set(sessionId, s);
    }
    return s;
  }
}
