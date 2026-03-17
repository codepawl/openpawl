import { describe, it, expect } from "vitest";
import { detectBreadth, suggestSplits } from "./breadth-analyzer.js";

describe("detectBreadth", () => {
  it("detects 3+ distinct domains as too_broad", () => {
    const result = detectBreadth(
      "Fix auth login, optimize database queries, and add API rate limiting",
    );
    expect(result.isTooWide).toBe(true);
    expect(result.domains.length).toBeGreaterThanOrEqual(3);
  });

  it("detects 4 domains", () => {
    const result = detectBreadth(
      "Update auth, fix SQL queries, add React component, and deploy to Docker",
    );
    expect(result.isTooWide).toBe(true);
    expect(result.domains.length).toBeGreaterThanOrEqual(4);
  });

  it("does not flag goals with 2 domains", () => {
    const result = detectBreadth("Add API endpoint for database query");
    expect(result.isTooWide).toBe(false);
    expect(result.domains.length).toBeLessThanOrEqual(2);
  });

  it("does not flag goals with 1 domain", () => {
    const result = detectBreadth("Add rate limiting to the REST API endpoints");
    expect(result.isTooWide).toBe(false);
  });

  it("does not flag goals with 0 domains", () => {
    const result = detectBreadth("Write a blog post about TypeScript");
    expect(result.isTooWide).toBe(false);
    expect(result.domains).toHaveLength(0);
  });

  it("returns matched keywords per domain", () => {
    const result = detectBreadth("Add auth login and JWT session handling");
    expect(result.domainMatches.auth).toBeDefined();
    expect(result.domainMatches.auth!.length).toBeGreaterThan(0);
  });
});

describe("suggestSplits", () => {
  it("returns up to 4 split suggestions", () => {
    const splits = suggestSplits(
      "Fix auth, database, API, and frontend",
      ["auth", "database", "api", "frontend"],
    );
    expect(splits.length).toBeLessThanOrEqual(4);
    expect(splits.length).toBeGreaterThan(0);
  });

  it("returns empty for empty domains", () => {
    const splits = suggestSplits("some goal", []);
    expect(splits).toHaveLength(0);
  });
});
