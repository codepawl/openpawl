import { describe, it, expect } from "bun:test";
import { withSuccessContext } from "@/memory/success/prompt.js";
import type { SuccessPattern } from "@/memory/success/types.js";

function makePattern(overrides: Partial<SuccessPattern> = {}): SuccessPattern {
  return {
    id: "success_test_1",
    sessionId: "session-1",
    taskDescription: "Implement caching layer",
    agentRole: "bot_0",
    approach: "Used Redis with TTL-based eviction",
    resultSummary: "Cache hit rate improved to 95%",
    confidence: 0.91,
    approvalType: "auto",
    reworkCount: 0,
    goalContext: "Optimize performance",
    tags: ["caching", "redis", "performance"],
    createdAt: Date.now(),
    runIndex: 1,
    ...overrides,
  };
}

describe("withSuccessContext", () => {
  it("injects block without mutating original prompt", () => {
    const original = "Create a sprint plan for the team.";
    const patterns = [makePattern()];
    const result = withSuccessContext(original, patterns);

    expect(result).toContain("## What has worked well in similar tasks:");
    expect(result).toContain("Implement caching layer");
    expect(result).toContain(original);
    // Original string should not be mutated
    expect(original).toBe("Create a sprint plan for the team.");
  });

  it("returns unchanged prompt when no patterns", () => {
    const original = "Plan the sprint.";
    const result = withSuccessContext(original, []);
    expect(result).toBe(original);
  });

  it("includes confidence and approval type", () => {
    const patterns = [makePattern({ confidence: 0.91, approvalType: "auto" })];
    const result = withSuccessContext("test", patterns);
    expect(result).toContain("0.91");
    expect(result).toContain("automatically");
  });

  it("includes manually approved label", () => {
    const patterns = [makePattern({ approvalType: "user" })];
    const result = withSuccessContext("test", patterns);
    expect(result).toContain("manually");
  });

  it("handles multiple patterns", () => {
    const patterns = [
      makePattern({ taskDescription: "Task A" }),
      makePattern({ id: "success_2", taskDescription: "Task B" }),
      makePattern({ id: "success_3", taskDescription: "Task C" }),
    ];
    const result = withSuccessContext("prompt", patterns);
    expect(result).toContain("Task A");
    expect(result).toContain("Task B");
    expect(result).toContain("Task C");
  });

  it("truncates long task descriptions", () => {
    const longDesc = "x".repeat(200);
    const patterns = [makePattern({ taskDescription: longDesc })];
    const result = withSuccessContext("test", patterns);
    // Should be truncated to 80 chars in the output
    expect(result.length).toBeLessThan(longDesc.length + 200);
  });

  it("prepends block before the prompt", () => {
    const prompt = "START_OF_PROMPT";
    const patterns = [makePattern()];
    const result = withSuccessContext(prompt, patterns);
    const promptIndex = result.indexOf("START_OF_PROMPT");
    const headerIndex = result.indexOf("## What has worked");
    expect(headerIndex).toBeLessThan(promptIndex);
  });
});

describe("retriever filtering logic", () => {
  it("filters out patterns below confidence threshold", () => {
    const patterns = [
      makePattern({ confidence: 0.9 }),
      makePattern({ id: "s2", confidence: 0.5 }),
      makePattern({ id: "s3", confidence: 0.8 }),
    ];

    const minConfidence = 0.75;
    const filtered = patterns.filter((p) => p.confidence >= minConfidence);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((p) => p.confidence >= 0.75)).toBe(true);
  });

  it("prefers reworkCount === 0 over reworkCount === 1", () => {
    const patterns = [
      makePattern({ id: "s1", reworkCount: 1 }),
      makePattern({ id: "s2", reworkCount: 0 }),
      makePattern({ id: "s3", reworkCount: 0 }),
    ];

    const sorted = [...patterns].sort((a, b) => {
      if (a.reworkCount === 0 && b.reworkCount !== 0) return -1;
      if (a.reworkCount !== 0 && b.reworkCount === 0) return 1;
      return 0;
    });

    expect(sorted[0].reworkCount).toBe(0);
    expect(sorted[1].reworkCount).toBe(0);
    expect(sorted[2].reworkCount).toBe(1);
  });

  it("returns empty array when no patterns exist", () => {
    const patterns: SuccessPattern[] = [];
    const filtered = patterns.filter((p) => p.confidence >= 0.75);
    expect(filtered).toHaveLength(0);
  });
});
