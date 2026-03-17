import { describe, it, expect } from "vitest";
import { summarizeTasks } from "./summarizer.js";

describe("summarizeTasks", () => {
  it("returns empty array for no descriptions", () => {
    expect(summarizeTasks([])).toEqual([]);
  });

  it("shows single tasks as-is in past tense", () => {
    const result = summarizeTasks(["Draft caching layer RFC"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Drafted caching layer RFC");
  });

  it("groups tasks with same verb + noun prefix", () => {
    const descriptions = [
      "Implement OAuth2 client",
      "Implement OAuth2 refresh",
      "Implement OAuth2 tests",
    ];
    const result = summarizeTasks(descriptions);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Implemented");
    expect(result[0]).toContain("oauth2");
    expect(result[0]).toContain("3 tasks");
  });

  it("mixes grouped and single tasks", () => {
    const descriptions = [
      "Implement auth client",
      "Implement auth tests",
      "Draft caching layer RFC",
    ];
    const result = summarizeTasks(descriptions);
    expect(result).toHaveLength(2);
    // Grouped comes first (higher count)
    expect(result[0]).toContain("2 tasks");
    expect(result[1]).toContain("Drafted");
  });

  it("limits output to maxItems", () => {
    const descriptions = Array.from({ length: 10 }, (_, i) => `Task${i} item${i}`);
    const result = summarizeTasks(descriptions, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("defaults to max 5 items", () => {
    const descriptions = Array.from({ length: 20 }, (_, i) => `Task${i} item${i}`);
    const result = summarizeTasks(descriptions);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("handles irregular past tense verbs", () => {
    const result = summarizeTasks(["Write integration tests"]);
    expect(result[0]).toBe("Wrote integration tests");
  });

  it("handles verbs ending in e", () => {
    const result = summarizeTasks(["Refactore module logic"]);
    expect(result[0]).toContain("Refactored");
  });

  it("never makes LLM calls (is synchronous)", () => {
    // If summarizeTasks were async or made network calls, this would fail
    const result = summarizeTasks(["Add feature"]);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });
});
