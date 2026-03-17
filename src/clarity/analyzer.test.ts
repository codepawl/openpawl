import { describe, it, expect } from "vitest";
import {
  analyzeClarity,
  calculateClarityScore,
  hasSuccessCriteria,
  hasMetrics,
  VAGUE_VERBS,
  UNSPECIFIED_NOUNS,
} from "./analyzer.js";
import type { ClarityIssue } from "./types.js";

describe("analyzeClarity", () => {
  describe("vague verb detection", () => {
    for (const verb of VAGUE_VERBS) {
      it(`detects vague_verb for "${verb}"`, () => {
        const result = analyzeClarity(`${verb} the auth module`);
        const vagueIssues = result.issues.filter((i) => i.type === "vague_verb");
        expect(vagueIssues.length).toBeGreaterThanOrEqual(1);
        expect(vagueIssues.some((i) => i.fragment === verb)).toBe(true);
      });
    }

    it("does not flag specific verbs", () => {
      const result = analyzeClarity("Add rate limiting to the auth API — max 100 req/min per user");
      const vagueIssues = result.issues.filter((i) => i.type === "vague_verb");
      expect(vagueIssues).toHaveLength(0);
    });
  });

  describe("unspecified noun detection", () => {
    for (const noun of UNSPECIFIED_NOUNS) {
      it(`detects unspecified_noun for "${noun}"`, () => {
        const goal = noun === "it" || noun === "this" || noun === "that"
          ? `Fix ${noun} before release`
          : `Improve ${noun}`;
        const result = analyzeClarity(goal);
        const nounIssues = result.issues.filter((i) => i.type === "unspecified_noun");
        expect(nounIssues.length).toBeGreaterThanOrEqual(1);
      });
    }
  });

  describe("success criteria detection", () => {
    it("flags missing_success_criteria when no signals present", () => {
      const result = analyzeClarity("Add pagination to the list endpoint");
      const scIssues = result.issues.filter((i) => i.type === "missing_success_criteria");
      expect(scIssues).toHaveLength(1);
    });

    it("does NOT flag missing_success_criteria when signals present", () => {
      const result = analyzeClarity("Reduce API latency to under 200ms on all endpoints");
      const scIssues = result.issues.filter((i) => i.type === "missing_success_criteria");
      expect(scIssues).toHaveLength(0);
    });

    it("does NOT flag when 'so that' is present", () => {
      const result = analyzeClarity("Add caching to the auth service so that login is faster");
      const scIssues = result.issues.filter((i) => i.type === "missing_success_criteria");
      expect(scIssues).toHaveLength(0);
    });

    it("does NOT flag when metric percentage is present", () => {
      const result = analyzeClarity("Increase test coverage to 80%");
      const scIssues = result.issues.filter((i) => i.type === "missing_success_criteria");
      expect(scIssues).toHaveLength(0);
    });
  });

  describe("clarity score", () => {
    it("score >= 0.8 for specific, measurable goal", () => {
      const result = analyzeClarity("Add rate limiting to the auth API — max 100 req/min per user");
      expect(result.score).toBeGreaterThanOrEqual(0.8);
      expect(result.isClear).toBe(true);
    });

    it("score < 0.5 for vague_verb + unspecified_noun together", () => {
      const result = analyzeClarity("Improve the API");
      expect(result.score).toBeLessThan(0.5);
      expect(result.isClear).toBe(false);
    });

    it("score penalizes blocking issues more than advisory", () => {
      const blocking: ClarityIssue[] = [{
        type: "vague_verb", fragment: "improve", question: "?", severity: "blocking",
      }];
      const advisory: ClarityIssue[] = [{
        type: "vague_verb", fragment: "improve", question: "?", severity: "advisory",
      }];
      const blockingScore = calculateClarityScore("goal", blocking);
      const advisoryScore = calculateClarityScore("goal", advisory);
      expect(blockingScore).toBeLessThan(advisoryScore);
    });

    it("grants bonus for success criteria", () => {
      expect(hasSuccessCriteria("reduce latency to 200ms")).toBe(true);
      expect(hasSuccessCriteria("add pagination")).toBe(false);
    });

    it("grants bonus for metrics", () => {
      expect(hasMetrics("p99 < 200ms")).toBe(true);
      expect(hasMetrics("100 requests per second")).toBe(true);
      expect(hasMetrics("make it fast")).toBe(false);
    });
  });

  describe("severity rules", () => {
    it("vague_verb + unspecified_noun = blocking", () => {
      const result = analyzeClarity("Improve the system");
      const blocking = result.issues.filter((i) => i.severity === "blocking");
      expect(blocking.length).toBeGreaterThanOrEqual(1);
    });

    it("single vague_verb alone = advisory", () => {
      const result = analyzeClarity("Improve the auth API rate limiter to handle 100 req/min");
      const vagueIssues = result.issues.filter((i) => i.type === "vague_verb");
      for (const issue of vagueIssues) {
        expect(issue.severity).toBe("advisory");
      }
    });
  });

  describe("conflicting requirements", () => {
    it("detects simple but comprehensive", () => {
      const result = analyzeClarity("Build a simple but comprehensive auth system");
      const conflicts = result.issues.filter((i) => i.type === "conflicting_requirements");
      expect(conflicts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("ambiguous constraints", () => {
    it("detects 'make it faster'", () => {
      const result = analyzeClarity("Make the API faster");
      const ambiguous = result.issues.filter((i) => i.type === "ambiguous_constraint");
      expect(ambiguous.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("ignored types", () => {
    it("filters out ignored issue types", () => {
      const result = analyzeClarity("Improve the API", { ignoredTypes: ["vague_verb"] });
      const vagueIssues = result.issues.filter((i) => i.type === "vague_verb");
      expect(vagueIssues).toHaveLength(0);
    });
  });

  describe("empty goal", () => {
    it("returns score 0 for empty goal", () => {
      const result = analyzeClarity("");
      expect(result.score).toBe(0);
      expect(result.isClear).toBe(false);
    });

    it("returns missing_scope for whitespace-only goal", () => {
      const result = analyzeClarity("   ");
      expect(result.issues[0]?.type).toBe("missing_scope");
    });
  });

  describe("error resilience", () => {
    it("does not throw for any input", () => {
      expect(() => analyzeClarity("")).not.toThrow();
      expect(() => analyzeClarity("x".repeat(10000))).not.toThrow();
      expect(() => analyzeClarity("🚀 emoji goal 🎯")).not.toThrow();
    });
  });
});
