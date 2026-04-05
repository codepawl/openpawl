import { describe, it, expect } from "vitest";
import { LatencyTracker } from "../../src/performance/latency-tracker.js";

describe("LatencyTracker", () => {
  it("metrics calculated correctly from marks", () => {
    const tracker = new LatencyTracker();
    const req = tracker.startRequest("s1", "coder");

    req.markSubmitted();
    req.markContextBuilt();
    req.markRequestSent();
    req.markFirstToken();
    req.markComplete(100);

    const metrics = req.getMetrics();
    expect(metrics.ttftMs).toBeGreaterThanOrEqual(0);
    expect(metrics.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("session summary aggregates across requests", () => {
    const tracker = new LatencyTracker();

    tracker.recordMetrics("s1", { contextBuildMs: 10, networkLatencyMs: 50, ttftMs: 100, totalMs: 500, tokensPerSecond: 40 });
    tracker.recordMetrics("s1", { contextBuildMs: 15, networkLatencyMs: 60, ttftMs: 120, totalMs: 600, tokensPerSecond: 50 });

    const summary = tracker.getSessionLatency("s1");
    expect(summary.requestCount).toBe(2);
    expect(summary.averageTTFT).toBe(110);
    expect(summary.averageTPS).toBe(45);
  });

  it("p95 calculated from sorted array", () => {
    const tracker = new LatencyTracker();
    for (let i = 0; i < 20; i++) {
      tracker.recordMetrics("s1", { contextBuildMs: 5, networkLatencyMs: 10, ttftMs: 100 + i * 10, totalMs: 500, tokensPerSecond: 50 });
    }
    const summary = tracker.getSessionLatency("s1");
    expect(summary.p95TTFT).toBeGreaterThan(summary.p50TTFT);
  });

  it("empty session returns zeros", () => {
    const tracker = new LatencyTracker();
    const summary = tracker.getSessionLatency("nonexistent");
    expect(summary.requestCount).toBe(0);
    expect(summary.averageTTFT).toBe(0);
  });
});
