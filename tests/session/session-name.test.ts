import { describe, it, expect } from "vitest";
import { generateSessionName } from "../../src/session/session-name.js";

describe("generateSessionName", () => {
  it("returns short goal text unchanged", () => {
    expect(generateSessionName("Build auth system")).toBe("Build auth system");
  });

  it("capitalizes first letter", () => {
    expect(generateSessionName("build auth system")).toBe("Build auth system");
  });

  it("truncates long text at word boundary with ellipsis", () => {
    const long = "Implement a rate limiter middleware for the Fastify server that supports sliding window";
    const result = generateSessionName(long);
    expect(result.length).toBeLessThanOrEqual(44); // 40 + "..."
    expect(result).toEndWith("...");
    expect(result).not.toContain("  ");
  });

  it("returns 'Untitled session' for empty string", () => {
    expect(generateSessionName("")).toBe("Untitled session");
  });

  it("returns 'Untitled session' for whitespace-only input", () => {
    expect(generateSessionName("   \n  \t  ")).toBe("Untitled session");
  });

  it("strips common conversational prefixes", () => {
    expect(generateSessionName("help me build a todo app")).toBe("Build a todo app");
    expect(generateSessionName("please create a REST API")).toBe("Create a REST API");
    expect(generateSessionName("I want to make a blog")).toBe("Make a blog");
    expect(generateSessionName("can you fix the login bug")).toBe("Fix the login bug");
  });

  it("collapses multiple whitespace", () => {
    expect(generateSessionName("build   a    todo   app")).toBe("Build a todo app");
  });

  it("handles exact 40-char input without truncation", () => {
    const exact = "A".repeat(40);
    expect(generateSessionName(exact)).toBe(exact);
  });

  it("handles 41-char input with truncation", () => {
    const input = "Build " + "a".repeat(35); // 41 chars
    const result = generateSessionName(input);
    expect(result).toEndWith("...");
  });
});
