import { describe, it, expect } from "vitest";
import { generateSuggestions } from "../../src/onboard/auto-configurator.js";
import type { ProjectAnalysis } from "../../src/onboard/project-analyzer.js";

function makeAnalysis(overrides: Partial<ProjectAnalysis> = {}): ProjectAnalysis {
  return {
    type: "node",
    name: "test-project",
    language: "typescript",
    packageManager: "pnpm",
    hasDocker: false,
    hasCI: false,
    hasDocs: false,
    hasTests: true,
    sourceDir: "src/",
    testDir: "tests/",
    estimatedSize: "medium",
    conventions: { indentation: "spaces-2", quotes: "single", fileNaming: "kebab" },
    ...overrides,
  };
}

describe("generateSuggestions", () => {
  it("TypeScript project suggests coder + tester + reviewer", () => {
    const suggestions = generateSuggestions(makeAnalysis({ testRunner: "vitest" }));
    const agentIds = suggestions.agents.map((a) => a.agentId);
    expect(agentIds).toContain("coder");
    expect(agentIds).toContain("tester");
    expect(agentIds).toContain("reviewer");
  });

  it("project without tests suggests tester with high priority", () => {
    const suggestions = generateSuggestions(makeAnalysis({ hasTests: false, testRunner: undefined }));
    const tester = suggestions.agents.find((a) => a.agentId === "tester");
    expect(tester).toBeDefined();
    expect(suggestions.promptRules.some((r) => r.includes("no tests"))).toBe(true);
  });

  it("Express project adds REST convention rule", () => {
    const suggestions = generateSuggestions(makeAnalysis({ framework: "express" }));
    expect(suggestions.promptRules.some((r) => r.includes("REST"))).toBe(true);
  });

  it("large project enables planner", () => {
    const suggestions = generateSuggestions(makeAnalysis({ estimatedSize: "large" }));
    expect(suggestions.agents.some((a) => a.agentId === "planner")).toBe(true);
  });

  it("suggestions are deterministic", () => {
    const a = generateSuggestions(makeAnalysis());
    const b = generateSuggestions(makeAnalysis());
    expect(a.agents.map((x) => x.agentId)).toEqual(b.agents.map((x) => x.agentId));
  });
});
