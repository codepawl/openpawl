import { describe, it, expect } from "vitest";
import { generateSuggestions } from "@/standup/suggester.js";
import type { BlockedItem, SessionSummary } from "@/standup/types.js";

function blocked(overrides: Partial<BlockedItem> & Pick<BlockedItem, "type">): BlockedItem {
  return {
    description: "test item",
    sessionId: "s1",
    priority: "medium",
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    goal: "Build API endpoints",
    tasksCompleted: 3,
    reworkCount: 0,
    allApproved: true,
    costUSD: 0.5,
    ...overrides,
  };
}

describe("generateSuggestions", () => {
  it("prioritizes approved RFCs over deferred tasks", () => {
    const items: BlockedItem[] = [
      blocked({ type: "deferred_task", description: "deferred work" }),
      blocked({ type: "open_rfc", description: "auth redesign" }),
    ];

    const results = generateSuggestions(items, []);

    expect(results[0].type).toBe("execute_rfc");
  });

  it("prioritizes escalated tasks over agent health alerts", () => {
    const items: BlockedItem[] = [
      blocked({ type: "agent_alert", description: "agent X low confidence" }),
      blocked({ type: "escalated_task", description: "critical bug" }),
    ];

    const results = generateSuggestions(items, []);

    expect(results[0].type).toBe("resolve_escalation");
    expect(results[1].type).toBe("agent_health");
  });

  it("caps at 3 suggestions", () => {
    const items: BlockedItem[] = [
      blocked({ type: "open_rfc", description: "rfc 1" }),
      blocked({ type: "open_rfc", description: "rfc 2" }),
      blocked({ type: "escalated_task", description: "esc 1" }),
      blocked({ type: "agent_alert", description: "alert 1" }),
      blocked({ type: "deferred_task", description: "deferred 1" }),
    ];

    const results = generateSuggestions(items, []);

    expect(results).toHaveLength(3);
  });

  it("returns momentum signal when last 3 sessions share domain", () => {
    const sessions: SessionSummary[] = [
      session({ sessionId: "s1", goal: "Build API auth module" }),
      session({ sessionId: "s2", goal: "Build API rate limiter" }),
      session({ sessionId: "s3", goal: "Build API caching layer" }),
    ];

    const results = generateSuggestions([], sessions);

    expect(results).toHaveLength(1);
    expect(results[0].description).toContain("You're on a roll");
    expect(results[0].type).toBe("follow_up");
  });
});
