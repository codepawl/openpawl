import { describe, it, expect } from "vitest";
import { renderStandup, exportMarkdown, renderWeeklySummary } from "@/standup/renderer.js";
import type { StandupData, WeeklySummary } from "@/standup/types.js";

function makeStandupData(overrides: Partial<StandupData> = {}): StandupData {
  return {
    date: "2026-03-18",
    yesterday: {
      sessions: [
        {
          sessionId: "sess-001",
          goal: "Implement user auth flow",
          tasksCompleted: 4,
          reworkCount: 0,
          allApproved: true,
          costUSD: 1.25,
        },
      ],
      totalCostUSD: 1.25,
      totalTasks: 4,
      teamLearnings: ["Cache invalidation needs explicit TTL"],
    },
    blocked: [
      {
        type: "open_rfc",
        description: "RFC-12 pending review from stakeholder",
        sessionId: "sess-001",
        priority: "medium",
      },
    ],
    suggested: [
      {
        type: "execute_rfc",
        description: "Execute RFC-12 once approved",
        reasoning: "Unblocks downstream auth work",
      },
    ],
    streak: 3,
    weekCostUSD: 8.5,
    globalPatternsCount: 7,
    ...overrides,
  };
}

function makeWeeklySummary(overrides: Partial<WeeklySummary> = {}): WeeklySummary {
  return {
    weekLabel: "2026-W12",
    sessionCount: 5,
    activeDays: 4,
    tasksCompleted: 18,
    autoApproved: 14,
    reworkCount: 2,
    totalCostUSD: 12.75,
    avgConfidence: 0.85,
    prevWeekAvgConfidence: 0.8,
    newGlobalPatterns: 3,
    newSessionPatterns: 5,
    topDomains: [
      { domain: "auth", taskCount: 7 },
      { domain: "api", taskCount: 6 },
    ],
    bestDay: {
      dayLabel: "Wednesday",
      taskCount: 6,
      costUSD: 3.2,
      avgConfidence: 0.92,
    },
    streak: 4,
    ...overrides,
  };
}

describe("renderStandup", () => {
  it("shows empty state message when no sessions", () => {
    const data = makeStandupData({
      yesterday: {
        sessions: [],
        totalCostUSD: 0,
        totalTasks: 0,
        teamLearnings: [],
      },
    });

    const output = renderStandup(data);

    expect(output).toContain("No sessions yesterday");
  });

  it("shows clean slate when nothing blocked", () => {
    const data = makeStandupData({ blocked: [] });

    const output = renderStandup(data);

    expect(output).toContain("Nothing blocked");
  });

  it("formats footer with streak and weekly cost", () => {
    const data = makeStandupData({ streak: 5, weekCostUSD: 12.5 });

    const output = renderStandup(data);

    expect(output).toContain("5-day streak");
    expect(output).toContain("$12.50");
  });
});

describe("exportMarkdown", () => {
  it("produces valid CommonMark markdown with all sections", () => {
    const data = makeStandupData();

    const output = exportMarkdown(data);

    expect(output).toMatch(/^# Standup/);
    expect(output).toContain("## Yesterday");
    expect(output).toContain("## Blocked");
    expect(output).toContain("## Suggested Next Steps");
  });
});

describe("renderWeeklySummary", () => {
  it("aggregates and includes all sections", () => {
    const summary = makeWeeklySummary();

    const output = renderWeeklySummary(summary);

    expect(output).toContain("Weekly Summary");
    expect(output).toContain("Sessions: 5");
    expect(output).toContain("Active days: 4/7");
    expect(output).toContain("Tasks: 18 completed");
    expect(output).toContain("$12.75");
    expect(output).toContain("85%");
    expect(output).toContain("auth");
    expect(output).toContain("Wednesday");
  });
});
