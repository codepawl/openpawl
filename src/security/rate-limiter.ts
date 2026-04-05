/**
 * Per-agent outgoing request rate limiter (sliding window).
 */

export class AgentRateLimiter {
  private windows = new Map<string, number[]>();
  private maxPerMinute: number;
  private maxPerAgent: number;

  constructor(config?: { maxRequestsPerMinute?: number; maxRequestsPerAgent?: number }) {
    this.maxPerMinute = config?.maxRequestsPerMinute ?? 30;
    this.maxPerAgent = config?.maxRequestsPerAgent ?? 10;
  }

  checkLimit(agentId: string): boolean {
    this.cleanup(agentId);
    const window = this.windows.get(agentId) ?? [];
    return window.length < this.maxPerAgent;
  }

  recordRequest(agentId: string): void {
    if (!this.windows.has(agentId)) this.windows.set(agentId, []);
    this.windows.get(agentId)!.push(Date.now());
  }

  getUsage(agentId: string): { used: number; limit: number; resetIn: number } {
    this.cleanup(agentId);
    const window = this.windows.get(agentId) ?? [];
    const oldest = window[0] ?? Date.now();
    return {
      used: window.length,
      limit: this.maxPerAgent,
      resetIn: Math.max(0, 60_000 - (Date.now() - oldest)),
    };
  }

  private cleanup(agentId: string): void {
    const cutoff = Date.now() - 60_000;
    const window = this.windows.get(agentId);
    if (!window) return;
    const filtered = window.filter((t) => t > cutoff);
    this.windows.set(agentId, filtered);
  }
}
