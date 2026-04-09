/**
 * Real-time token usage tracking per session.
 * Tracks input/output tokens by provider and agent.
 */

import { EventEmitter } from "node:events";
import type { TokenSummary, TokenUpdateEvent } from "./types.js";

export class TokenTracker extends EventEmitter {
  private sessions = new Map<string, TokenSummary>();

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
    const prov = summary.byProvider[provider] ?? { tokens: 0 };
    prov.tokens += inputTokens + outputTokens;
    summary.byProvider[provider] = prov;

    // By agent
    const agent = summary.byAgent[agentId] ?? { tokens: 0 };
    agent.tokens += inputTokens + outputTokens;
    summary.byAgent[agentId] = agent;

    const event: TokenUpdateEvent = {
      type: "tokens:update",
      sessionId,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      timestamp: Date.now(),
    };
    this.emit("tokens:update", event);
  }

  getSessionTokens(sessionId: string): TokenSummary {
    return this.getOrCreate(sessionId);
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private getOrCreate(sessionId: string): TokenSummary {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { totalInputTokens: 0, totalOutputTokens: 0, byProvider: {}, byAgent: {} };
      this.sessions.set(sessionId, s);
    }
    return s;
  }
}
