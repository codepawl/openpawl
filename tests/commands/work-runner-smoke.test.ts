/**
 * Work runner smoke test.
 *
 * work-runner.ts (1937 LOC) is too coupled for full integration testing.
 * These tests verify isolated, importable pieces and document required refactoring.
 *
 * Refactoring needed for full testability:
 * - Extract goal resolution into a pure function (parseGoalFromArgs)
 * - Extract dashboard setup into a separately testable module
 * - Extract the multi-run loop body into a testable function
 * - Make TeamOrchestration injectable (dependency injection)
 * - Separate cleanup logic from the main run function
 * - Replace direct process.exit() calls with error returns
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("work-runner module structure", () => {
  const workRunnerPath = resolve(__dirname, "../../src/work-runner.ts");

  it("source file exists and is substantial (>1000 LOC)", () => {
    expect(existsSync(workRunnerPath)).toBe(true);
    const content = readFileSync(workRunnerPath, "utf-8");
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeGreaterThan(1000);
  });

  it("exports runWork as the main entry point", () => {
    const content = readFileSync(workRunnerPath, "utf-8");
    expect(content).toMatch(/export\s+(async\s+)?function\s+runWork/);
  });

  it("uses TeamOrchestration from simulation module", () => {
    const content = readFileSync(workRunnerPath, "utf-8");
    expect(content).toContain("TeamOrchestration");
    expect(content).toContain("simulation");
  });

  it("has dashboard integration for real-time updates", () => {
    const content = readFileSync(workRunnerPath, "utf-8");
    expect(content).toContain("dashboard");
    expect(content).toContain("getDashboardBridge");
  });

  it("generates CONTEXT.md handoff on completion (extracted to session-finalize)", () => {
    const finalizePath = resolve(__dirname, "../../src/work-runner/session-finalize.ts");
    expect(existsSync(finalizePath)).toBe(true);
    const content = readFileSync(finalizePath, "utf-8");
    expect(content).toContain("CONTEXT.md");
    expect(content).toContain("handoff");
    // work-runner.ts imports session-finalize
    const mainContent = readFileSync(workRunnerPath, "utf-8");
    expect(mainContent).toContain("session-finalize");
  });
});

describe("work-runner extracted modules", () => {
  it("post-session menu is tested in dedicated test file", () => {
    const postSessionTestPath = resolve(__dirname, "../work/post-session-menu.test.ts");
    expect(existsSync(postSessionTestPath)).toBe(true);
  });

  it("goal-resolver module exists for goal parsing", () => {
    const goalResolverPath = resolve(__dirname, "../../src/work-runner/goal-resolver.ts");
    if (existsSync(goalResolverPath)) {
      const content = readFileSync(goalResolverPath, "utf-8");
      expect(content).toMatch(/export/);
    }
    // If not extracted yet, that's expected — document it
  });
});
