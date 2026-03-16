import { describe, it, expect } from "vitest";
import { withConfidenceScoring } from "../src/graph/confidence/prompt.js";

describe("withConfidenceScoring", () => {
  it("appends confidence instructions to the prompt", () => {
    const original = "Please implement the feature.";
    const wrapped = withConfidenceScoring(original);
    expect(wrapped).toContain(original);
    expect(wrapped).toContain("<confidence_instructions>");
    expect(wrapped).toContain("</confidence_instructions>");
    expect(wrapped.length).toBeGreaterThan(original.length);
  });

  it("does not mutate the original prompt string", () => {
    const original = "Do the thing.";
    const copy = original.slice();
    withConfidenceScoring(original);
    expect(original).toBe(copy);
  });

  it("includes scoring rubric and flag definitions", () => {
    const wrapped = withConfidenceScoring("task");
    expect(wrapped).toContain("score:");
    expect(wrapped).toContain("reasoning:");
    expect(wrapped).toContain("flags:");
    expect(wrapped).toContain("missing_context");
    expect(wrapped).toContain("high_complexity");
    expect(wrapped).toContain("0.90-1.00");
  });

  it("includes the confidence XML format", () => {
    const wrapped = withConfidenceScoring("task");
    expect(wrapped).toContain("<confidence>");
    expect(wrapped).toContain("</confidence>");
  });
});
