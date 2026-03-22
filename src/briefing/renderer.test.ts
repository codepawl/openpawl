import { describe, it, expect } from "vitest";
import { renderBriefing, renderWelcome, renderInterRunSummary } from "./renderer.js";
import type { BriefingData } from "./types.js";

function makeBriefingData(overrides: Partial<BriefingData> = {}): BriefingData {
  return {
    lastSession: {
      sessionId: "sess-abc123456789",
      goal: "Build auth module",
      completedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
      daysAgo: 2,
      totalCostUSD: 0.13,
      tasksCompleted: 5,
    },
    whatWasBuilt: ["Refactored auth module (3 tasks)", "Added token refresh logic"],
    teamLearnings: ["PKCE flow is more secure than implicit"],
    leftOpen: [{ taskDescription: "Add rate limiting to auth endpoints", reason: "escalated" as const, sessionId: "sess-abc123" }],
    teamPerformance: [],
    newGlobalPatterns: 2,
    openRFCs: [],
    relevantDecisions: [],
    ...overrides,
  };
}

describe("renderBriefing", () => {
  it("shows welcome message when lastSession is null", () => {
    const output = renderBriefing({ ...makeBriefingData(), lastSession: null });
    expect(output).toContain("Welcome to TeamClaw");
    expect(output).toContain("No previous sessions found");
  });

  it("shows Previously on TeamClaw for returning users", () => {
    const output = renderBriefing(makeBriefingData());
    expect(output).toContain("Previously on TeamClaw");
  });

  it("shows what was built", () => {
    const output = renderBriefing(makeBriefingData());
    expect(output).toContain("What was built:");
    expect(output).toContain("Refactored auth module");
  });

  it("shows team learnings", () => {
    const output = renderBriefing(makeBriefingData());
    expect(output).toContain("What the team learned:");
    expect(output).toContain("PKCE flow");
  });

  it("shows left open items", () => {
    const output = renderBriefing(makeBriefingData());
    expect(output).toContain("Left open:");
    expect(output).toContain("escalated");
  });

  it("limits output to 12 content lines max", () => {
    const data = makeBriefingData({
      whatWasBuilt: ["A", "B", "C", "D", "E"],
      teamLearnings: ["L1", "L2", "L3"],
      leftOpen: [
        { taskDescription: "T1", reason: "escalated", sessionId: "s" },
        { taskDescription: "T2", reason: "deferred", sessionId: "s" },
        { taskDescription: "T3", reason: "failed", sessionId: "s" },
      ],
      teamPerformance: [
        { agentRole: "worker", trend: "improving", confidenceDelta: 0.08, alert: false },
        { agentRole: "reviewer", trend: "degrading", confidenceDelta: -0.1, alert: true },
      ],
    });
    const output = renderBriefing(data);
    const lines = output.split("\n");
    // Content lines = total lines minus separator lines
    const separatorCount = lines.filter((l) => l.includes("━")).length;
    const contentLines = lines.length - separatorCount;
    expect(contentLines).toBeLessThanOrEqual(12);
  });

  it("skips stable agents in team performance section", () => {
    const data = makeBriefingData({
      teamPerformance: [
        { agentRole: "worker", trend: "stable", confidenceDelta: 0, alert: false },
      ],
    });
    const output = renderBriefing(data);
    expect(output).not.toContain("worker");
  });

  it("shows alert marker for degrading agents", () => {
    const data = makeBriefingData({
      teamPerformance: [
        { agentRole: "rfc_author", trend: "degrading", confidenceDelta: -0.1, alert: true },
      ],
    });
    const output = renderBriefing(data);
    expect(output).toContain("rfc_author");
    expect(output).toContain("below threshold");
  });

  it("shows improving agents with delta", () => {
    const data = makeBriefingData({
      teamPerformance: [
        { agentRole: "worker_bot", trend: "improving", confidenceDelta: 0.08, alert: false },
      ],
    });
    const output = renderBriefing(data);
    expect(output).toContain("worker_bot");
    expect(output).toContain("trending up");
    expect(output).toContain("+0.08");
  });
});

describe("renderWelcome", () => {
  it("shows welcome message", () => {
    const output = renderWelcome();
    expect(output).toContain("Welcome to TeamClaw");
    expect(output).toContain("No previous sessions found");
    expect(output).toContain("remembers everything");
  });
});

describe("renderInterRunSummary", () => {
  it("renders compact summary within 7 lines", () => {
    const output = renderInterRunSummary({
      completedRun: 1,
      nextRun: 2,
      averageConfidence: 0.81,
      targetConfidence: 0.87,
      newLessons: 3,
    });
    const lines = output.split("\n");
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(output).toContain("Run 1 complete");
    expect(output).toContain("Starting Run 2");
    expect(output).toContain("81%");
    expect(output).toContain("3 new lessons");
  });

  it("shows no-lessons message when 0", () => {
    const output = renderInterRunSummary({
      completedRun: 2,
      nextRun: 3,
      averageConfidence: 0.9,
      targetConfidence: 0.87,
      newLessons: 0,
    });
    expect(output).toContain("no new lessons");
  });
});
