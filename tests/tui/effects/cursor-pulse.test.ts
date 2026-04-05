import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CursorPulse, interpolateColor } from "../../../src/tui/effects/cursor-pulse.js";

describe("CursorPulse", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("start calls renderCallback periodically", () => {
    const cp = new CursorPulse();
    const calls: number[] = [];
    cp.start((b) => calls.push(b));
    vi.advanceTimersByTime(400); // ~5 frames at 80ms
    expect(calls.length).toBeGreaterThanOrEqual(4);
    cp.stop();
  });

  it("brightness oscillates between 0.4 and 1.0", () => {
    const cp = new CursorPulse();
    const values: number[] = [];
    cp.start((b) => values.push(b));
    vi.advanceTimersByTime(2000); // enough for full cycle
    expect(Math.min(...values)).toBeCloseTo(0.4, 1);
    expect(Math.max(...values)).toBeCloseTo(1.0, 1);
    cp.stop();
  });

  it("stop halts callbacks", () => {
    const cp = new CursorPulse();
    const calls: number[] = [];
    cp.start((b) => calls.push(b));
    vi.advanceTimersByTime(240);
    cp.stop();
    const countAfterStop = calls.length;
    vi.advanceTimersByTime(500);
    expect(calls.length).toBe(countAfterStop);
  });

  it("pause/resume work", () => {
    const cp = new CursorPulse();
    const calls: number[] = [];
    cp.start((b) => calls.push(b));
    vi.advanceTimersByTime(240);
    const beforePause = calls.length;
    cp.pause();
    vi.advanceTimersByTime(500);
    expect(calls.length).toBe(beforePause); // no new calls
    cp.resume();
    vi.advanceTimersByTime(240);
    expect(calls.length).toBeGreaterThan(beforePause); // resumed
    cp.stop();
  });
});

describe("interpolateColor", () => {
  it("t=0 returns colorA", () => {
    expect(interpolateColor("#ff0000", "#0000ff", 0)).toBe("#ff0000");
  });

  it("t=1 returns colorB", () => {
    expect(interpolateColor("#ff0000", "#0000ff", 1)).toBe("#0000ff");
  });

  it("t=0.5 returns midpoint", () => {
    const mid = interpolateColor("#000000", "#ffffff", 0.5);
    // Should be close to #808080
    expect(mid).toMatch(/^#[78][0-9a-f][78][0-9a-f][78][0-9a-f]$/);
  });
});
