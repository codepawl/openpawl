import { describe, it, expect } from "bun:test";
import {
  ContextTracker,
  estimateTokens,
  estimateMessageTokens,
} from "../../src/context/context-tracker.js";

describe("estimateTokens", () => {
  it("estimates ~4 chars per token for English text", () => {
    const text = "The quick brown fox jumps over the lazy dog"; // 43 chars
    const tokens = estimateTokens(text);
    expect(tokens).toBe(Math.ceil(43 / 4)); // 11
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles single character", () => {
    expect(estimateTokens("a")).toBe(1);
  });

  it("produces reasonable estimates for code", () => {
    const code = `function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}`;
    const tokens = estimateTokens(code);
    // Code is ~107 chars → ~27 tokens. Real tokenizers give ~30-35.
    // Within 15% tolerance is fine.
    expect(tokens).toBeGreaterThan(20);
    expect(tokens).toBeLessThan(40);
  });
});

describe("estimateMessageTokens", () => {
  it("sums tokens across multiple messages", () => {
    const messages = [
      { content: "hello" },       // 5 chars → 2 tokens
      { content: "world" },       // 5 chars → 2 tokens
      { content: "test input" },  // 10 chars → 3 tokens
    ];
    expect(estimateMessageTokens(messages)).toBe(
      estimateTokens("hello") + estimateTokens("world") + estimateTokens("test input"),
    );
  });

  it("returns 0 for empty array", () => {
    expect(estimateMessageTokens([])).toBe(0);
  });
});

describe("ContextTracker", () => {
  describe("snapshot", () => {
    it("returns 'normal' below 70%", () => {
      const tracker = new ContextTracker(1000);
      // 690 tokens = 69% → normal (need 690*4=2760 chars)
      const messages = [{ content: "x".repeat(2760) }];
      const snap = tracker.snapshot(messages);
      expect(snap.level).toBe("normal");
      expect(snap.utilizationPercent).toBe(69);
    });

    it("returns 'warning' at 70-79%", () => {
      const tracker = new ContextTracker(1000);
      // 750 tokens = 75% → warning (need 750*4=3000 chars)
      const messages = [{ content: "x".repeat(3000) }];
      const snap = tracker.snapshot(messages);
      expect(snap.level).toBe("warning");
      expect(snap.utilizationPercent).toBe(75);
    });

    it("returns 'high' at 80-84%", () => {
      const tracker = new ContextTracker(1000);
      // 820 tokens = 82% → high
      const messages = [{ content: "x".repeat(3280) }];
      const snap = tracker.snapshot(messages);
      expect(snap.level).toBe("high");
      expect(snap.utilizationPercent).toBe(82);
    });

    it("returns 'critical' at 85-98%", () => {
      const tracker = new ContextTracker(1000);
      // 900 tokens = 90% → critical
      const messages = [{ content: "x".repeat(3600) }];
      const snap = tracker.snapshot(messages);
      expect(snap.level).toBe("critical");
      expect(snap.utilizationPercent).toBe(90);
    });

    it("returns 'emergency' at 99%+", () => {
      const tracker = new ContextTracker(1000);
      // 1000 tokens = 100% → emergency
      const messages = [{ content: "x".repeat(4000) }];
      const snap = tracker.snapshot(messages);
      expect(snap.level).toBe("emergency");
      expect(snap.utilizationPercent).toBe(100);
    });

    it("includes estimatedTokens and maxTokens", () => {
      const tracker = new ContextTracker(5000);
      const messages = [{ content: "x".repeat(400) }]; // 100 tokens
      const snap = tracker.snapshot(messages);
      expect(snap.estimatedTokens).toBe(100);
      expect(snap.maxTokens).toBe(5000);
    });

    it("returns 0% for zero maxTokens", () => {
      const tracker = new ContextTracker(0);
      const messages = [{ content: "some text" }];
      const snap = tracker.snapshot(messages);
      expect(snap.utilizationPercent).toBe(0);
      expect(snap.level).toBe("normal");
    });
  });

  describe("shouldCompact", () => {
    const tracker = new ContextTracker(1000);

    it("returns false for normal", () => {
      expect(tracker.shouldCompact({ estimatedTokens: 500, maxTokens: 1000, utilizationPercent: 50, level: "normal" })).toBe(false);
    });

    it("returns false for warning", () => {
      expect(tracker.shouldCompact({ estimatedTokens: 750, maxTokens: 1000, utilizationPercent: 75, level: "warning" })).toBe(false);
    });

    it("returns true for high", () => {
      expect(tracker.shouldCompact({ estimatedTokens: 820, maxTokens: 1000, utilizationPercent: 82, level: "high" })).toBe(true);
    });

    it("returns true for critical", () => {
      expect(tracker.shouldCompact({ estimatedTokens: 900, maxTokens: 1000, utilizationPercent: 90, level: "critical" })).toBe(true);
    });

    it("returns true for emergency", () => {
      expect(tracker.shouldCompact({ estimatedTokens: 1000, maxTokens: 1000, utilizationPercent: 100, level: "emergency" })).toBe(true);
    });
  });

  describe("setMaxTokens", () => {
    it("updates max tokens and affects snapshot", () => {
      const tracker = new ContextTracker(1000);
      const messages = [{ content: "x".repeat(3200) }]; // 800 tokens

      expect(tracker.snapshot(messages).level).toBe("high"); // 80% of 1000

      tracker.setMaxTokens(2000);
      expect(tracker.snapshot(messages).level).toBe("normal"); // 40% of 2000
      expect(tracker.snapshot(messages).utilizationPercent).toBe(40);
    });
  });
});
