import { describe, it, expect } from "vitest";
import { rewriteGoal } from "./rewriter.js";
import type { ClarityIssue } from "./types.js";

function makeIssue(overrides: Partial<ClarityIssue> = {}): ClarityIssue {
  return {
    type: "vague_verb",
    fragment: "improve",
    question: "What kind of improvement?",
    severity: "advisory",
    ...overrides,
  };
}

describe("rewriteGoal", () => {
  it("returns original goal when no answers", () => {
    expect(rewriteGoal("Improve the API", [])).toBe("Improve the API");
  });

  it("replaces vague verb with answer", () => {
    const result = rewriteGoal("Improve the API", [{
      issue: makeIssue({ type: "vague_verb", fragment: "improve" }),
      answer: "Add rate limiting to",
    }]);
    expect(result).toContain("Add rate limiting to");
    expect(result).not.toMatch(/\bImprove\b/);
  });

  it("replaces unspecified noun with answer", () => {
    const result = rewriteGoal("Fix the API", [{
      issue: makeIssue({ type: "unspecified_noun", fragment: "the API" }),
      answer: "the public REST API",
    }]);
    expect(result).toContain("the public REST API");
  });

  it("appends success criteria", () => {
    const result = rewriteGoal("Add pagination", [{
      issue: makeIssue({ type: "missing_success_criteria" }),
      answer: "p99 < 200ms",
    }]);
    expect(result).toContain("p99 < 200ms");
    expect(result).toContain("target");
  });

  it("correctly combines goal + multiple answers", () => {
    const result = rewriteGoal("Improve the API", [
      {
        issue: makeIssue({ type: "vague_verb", fragment: "Improve" }),
        answer: "Optimize performance of",
      },
      {
        issue: makeIssue({ type: "unspecified_noun", fragment: "the API" }),
        answer: "the public REST API",
      },
      {
        issue: makeIssue({ type: "missing_success_criteria" }),
        answer: "p99 < 200ms",
      },
    ]);
    expect(result).toContain("Optimize performance of");
    expect(result).toContain("the public REST API");
    expect(result).toContain("p99 < 200ms");
  });

  it("skips empty answers", () => {
    const result = rewriteGoal("Improve the API", [{
      issue: makeIssue({ type: "missing_success_criteria" }),
      answer: "",
    }]);
    expect(result).toBe("Improve the API");
  });

  it("handles too_broad by narrowing scope", () => {
    const result = rewriteGoal("Fix auth, database, and API", [{
      issue: makeIssue({ type: "too_broad" }),
      answer: "Focus on auth only",
    }]);
    expect(result).toContain("Focus on auth only");
  });
});
