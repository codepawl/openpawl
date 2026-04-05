import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ThinkingIndicator } from "../../../src/tui/components/thinking-indicator.js";

describe("ThinkingIndicator", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("start() makes visible", () => {
    const ti = new ThinkingIndicator();
    ti.start();
    expect(ti.isVisible()).toBe(true);
  });

  it("stop() makes invisible", () => {
    const ti = new ThinkingIndicator();
    ti.start();
    ti.stop();
    expect(ti.isVisible()).toBe(false);
  });

  it("getCurrentText contains Thinking", () => {
    const ti = new ThinkingIndicator();
    ti.start();
    expect(ti.getCurrentText()).toContain("Thinking");
  });

  it("agent name appears in indicator when provided", () => {
    const ti = new ThinkingIndicator();
    ti.start("Coder", (s: string) => s);
    const text = ti.getCurrentText();
    expect(text).toContain("Coder");
    expect(text).toContain("thinking");
  });

  it("onUpdate called on interval", () => {
    const ti = new ThinkingIndicator();
    const updates: string[] = [];
    ti.onUpdate = (text) => updates.push(text);
    ti.start();
    vi.advanceTimersByTime(500); // ~4 frames
    expect(updates.length).toBeGreaterThanOrEqual(4);
  });

  it("stop() clears interval — no more updates", () => {
    const ti = new ThinkingIndicator();
    const updates: string[] = [];
    ti.onUpdate = (text) => updates.push(text);
    ti.start();
    vi.advanceTimersByTime(240);
    const countBefore = updates.length;
    ti.stop();
    vi.advanceTimersByTime(500);
    expect(updates.length).toBe(countBefore);
  });
});
