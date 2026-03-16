import { describe, it, expect } from "vitest";
import { classifyTaskType, getConfidenceGate, TASK_TYPE_KEYWORDS } from "../src/agents/profiles/classifier.js";
import type { TaskType } from "../src/agents/profiles/types.js";

describe("classifyTaskType", () => {
  it("classifies audit tasks", () => {
    expect(classifyTaskType("Review and audit the authentication module")).toBe("audit");
  });

  it("classifies research tasks", () => {
    expect(classifyTaskType("Research and analyze competing frameworks")).toBe("research");
  });

  it("classifies implement tasks", () => {
    expect(classifyTaskType("Implement the user registration feature")).toBe("implement");
  });

  it("classifies test tasks", () => {
    expect(classifyTaskType("Write unit test coverage for the parser")).toBe("test");
  });

  it("classifies refactor tasks", () => {
    expect(classifyTaskType("Refactor and simplify the data layer")).toBe("refactor");
  });

  it("classifies document tasks", () => {
    expect(classifyTaskType("Document the API endpoints in a guide")).toBe("document");
  });

  it("classifies design tasks", () => {
    expect(classifyTaskType("Design the database schema and architect the API")).toBe("design");
  });

  it("classifies debug tasks", () => {
    expect(classifyTaskType("Debug the crash and fix the null pointer error")).toBe("debug");
  });

  it("picks dominant category on mixed keywords", () => {
    // 3 debug keywords vs 1 implement keyword
    expect(classifyTaskType("Debug and fix this error, then resolve the crash")).toBe("debug");
  });

  it("returns general for empty string", () => {
    expect(classifyTaskType("")).toBe("general");
  });

  it("returns general for gibberish", () => {
    expect(classifyTaskType("xyzzy foobar baz qux")).toBe("general");
  });

  it("is case insensitive", () => {
    expect(classifyTaskType("IMPLEMENT the FEATURE and BUILD the module")).toBe("implement");
  });

  it("covers all 8 task type categories", () => {
    const categories = Object.keys(TASK_TYPE_KEYWORDS);
    expect(categories).toHaveLength(8);
    const expected: TaskType[] = ["audit", "research", "implement", "test", "refactor", "document", "design", "debug"];
    for (const cat of expected) {
      expect(categories).toContain(cat);
    }
  });
});

describe("getConfidenceGate", () => {
  it("returns IGNORE_PROFILE for count < 5", () => {
    expect(getConfidenceGate(0)).toBe("IGNORE_PROFILE");
    expect(getConfidenceGate(4)).toBe("IGNORE_PROFILE");
  });

  it("returns PARTIAL_WEIGHT for count 5-9", () => {
    expect(getConfidenceGate(5)).toBe("PARTIAL_WEIGHT");
    expect(getConfidenceGate(9)).toBe("PARTIAL_WEIGHT");
  });

  it("returns USE_PROFILE for count >= 10", () => {
    expect(getConfidenceGate(10)).toBe("USE_PROFILE");
    expect(getConfidenceGate(100)).toBe("USE_PROFILE");
  });
});
