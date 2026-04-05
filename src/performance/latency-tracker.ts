/**
 * Measure TTFT and other latency metrics.
 */

export interface RequestTracker {
  markSubmitted(): void;
  markContextBuilt(): void;
  markRequestSent(): void;
  markFirstToken(): void;
  markComplete(tokenCount: number): void;
  getMetrics(): LatencyMetrics;
}

export interface LatencyMetrics {
  contextBuildMs: number;
  networkLatencyMs: number;
  ttftMs: number;
  totalMs: number;
  tokensPerSecond: number;
}

export interface LatencySummary {
  averageTTFT: number;
  p50TTFT: number;
  p95TTFT: number;
  averageTPS: number;
  requestCount: number;
}

export class LatencyTracker {
  private sessions = new Map<string, LatencyMetrics[]>();

  startRequest(_sessionId: string, _agentId: string): RequestTracker {
    const marks = {
      submitted: 0,
      contextBuilt: 0,
      requestSent: 0,
      firstToken: 0,
      complete: 0,
      tokenCount: 0,
    };

    return {
      markSubmitted: () => { marks.submitted = performance.now(); },
      markContextBuilt: () => { marks.contextBuilt = performance.now(); },
      markRequestSent: () => { marks.requestSent = performance.now(); },
      markFirstToken: () => { marks.firstToken = performance.now(); },
      markComplete: (tokenCount: number) => {
        marks.complete = performance.now();
        marks.tokenCount = tokenCount;
      },
      getMetrics: (): LatencyMetrics => {
        const streamDuration = marks.complete - marks.firstToken;
        return {
          contextBuildMs: marks.contextBuilt - marks.submitted,
          networkLatencyMs: marks.firstToken - marks.requestSent,
          ttftMs: marks.firstToken - marks.submitted,
          totalMs: marks.complete - marks.submitted,
          tokensPerSecond: streamDuration > 0 ? (marks.tokenCount / streamDuration) * 1000 : 0,
        };
      },
    };
  }

  recordMetrics(sessionId: string, metrics: LatencyMetrics): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
    this.sessions.get(sessionId)!.push(metrics);
  }

  getSessionLatency(sessionId: string): LatencySummary {
    const metrics = this.sessions.get(sessionId) ?? [];
    if (metrics.length === 0) {
      return { averageTTFT: 0, p50TTFT: 0, p95TTFT: 0, averageTPS: 0, requestCount: 0 };
    }

    const ttfts = metrics.map((m) => m.ttftMs).sort((a, b) => a - b);
    const tps = metrics.map((m) => m.tokensPerSecond);

    return {
      averageTTFT: ttfts.reduce((s, v) => s + v, 0) / ttfts.length,
      p50TTFT: ttfts[Math.floor(ttfts.length * 0.5)] ?? 0,
      p95TTFT: ttfts[Math.floor(ttfts.length * 0.95)] ?? 0,
      averageTPS: tps.reduce((s, v) => s + v, 0) / tps.length,
      requestCount: metrics.length,
    };
  }
}
