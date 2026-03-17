import { describe, it, expect } from "vitest";
import { withDecisionContext } from "./prompt.js";
import type { Decision } from "./types.js";

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec-1",
    sessionId: "sess-123",
    runIndex: 1,
    capturedAt: Date.now(),
    topic: "Auth",
    decision: "Use PKCE flow",
    reasoning: "More secure than implicit",
    recommendedBy: "tech_lead",
    confidence: 0.91,
    taskId: "t-1",
    goalContext: "Build auth",
    tags: ["oauth"],
    embedding: [],
    status: "active",
    ...overrides,
  };
}

describe("withDecisionContext", () => {
  it("does not mutate original prompt", () => {
    const original = "Plan the sprint.";
    const decisions = [makeDecision()];
    const result = withDecisionContext(original, decisions);
    expect(result).not.toBe(original);
    expect(result).toContain(original);
    expect(original).toBe("Plan the sprint."); // unchanged
  });

  it("injects max 3 decisions into prompt", () => {
    const decisions = Array.from({ length: 5 }, (_, i) =>
      makeDecision({ id: `dec-${i}`, decision: `Decision ${i}` }),
    );
    const result = withDecisionContext("Plan.", decisions);

    // Count "Decision X" occurrences
    const matches = result.match(/Decision \d/g);
    expect(matches?.length).toBeLessThanOrEqual(3);
  });

  it("returns original prompt when no decisions provided", () => {
    const result = withDecisionContext("Plan.", []);
    expect(result).toBe("Plan.");
  });

  it("skips superseded decisions", () => {
    const decisions = [
      makeDecision({ id: "d1", status: "superseded", decision: "Old choice" }),
      makeDecision({ id: "d2", status: "active", decision: "New choice" }),
    ];
    const result = withDecisionContext("Plan.", decisions);
    expect(result).not.toContain("Old choice");
    expect(result).toContain("New choice");
  });

  it("includes confidence label", () => {
    const result = withDecisionContext("Plan.", [makeDecision({ confidence: 0.91 })]);
    expect(result).toContain("high confidence");
  });

  it("includes reasoning", () => {
    const result = withDecisionContext("Plan.", [makeDecision({ reasoning: "PKCE is more secure" })]);
    expect(result).toContain("PKCE is more secure");
  });

  it("includes honor instruction", () => {
    const result = withDecisionContext("Plan.", [makeDecision()]);
    expect(result).toContain("Honor these decisions");
  });
});
