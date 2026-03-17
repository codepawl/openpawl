import { describe, it, expect } from "vitest";
import { generateQuestions } from "./questioner.js";
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

describe("generateQuestions", () => {
  it("returns empty array for no issues", () => {
    expect(generateQuestions([])).toHaveLength(0);
  });

  it("returns max 3 questions regardless of issue count", () => {
    const issues: ClarityIssue[] = [
      makeIssue({ type: "vague_verb", question: "Q1" }),
      makeIssue({ type: "unspecified_noun", question: "Q2" }),
      makeIssue({ type: "missing_success_criteria", question: "Q3" }),
      makeIssue({ type: "ambiguous_constraint", question: "Q4" }),
      makeIssue({ type: "missing_scope", question: "Q5" }),
    ];
    const questions = generateQuestions(issues);
    expect(questions.length).toBeLessThanOrEqual(3);
  });

  it("prioritizes blocking issues over advisory", () => {
    const issues: ClarityIssue[] = [
      makeIssue({ type: "missing_success_criteria", severity: "advisory", question: "Advisory Q" }),
      makeIssue({ type: "vague_verb", severity: "blocking", question: "Blocking Q" }),
      makeIssue({ type: "unspecified_noun", severity: "advisory", question: "Advisory Q2" }),
    ];
    const questions = generateQuestions(issues);
    expect(questions[0]?.issue.severity).toBe("blocking");
  });

  it("deduplicates by issue type", () => {
    const issues: ClarityIssue[] = [
      makeIssue({ type: "vague_verb", fragment: "improve", question: "Q1" }),
      makeIssue({ type: "vague_verb", fragment: "fix", question: "Q2" }),
      makeIssue({ type: "unspecified_noun", question: "Q3" }),
    ];
    const questions = generateQuestions(issues);
    const types = questions.map((q) => q.issue.type);
    const uniqueTypes = new Set(types);
    expect(uniqueTypes.size).toBe(types.length);
  });

  it("includes placeholder text", () => {
    const issues: ClarityIssue[] = [
      makeIssue({ type: "vague_verb" }),
    ];
    const questions = generateQuestions(issues);
    expect(questions[0]?.placeholder).toBeDefined();
    expect(questions[0]?.placeholder?.length).toBeGreaterThan(0);
  });
});
