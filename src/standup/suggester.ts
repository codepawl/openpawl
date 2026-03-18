/**
 * Rule-based suggestion engine for standup.
 * No LLM calls — deterministic priority ordering.
 */

import type { BlockedItem, SuggestionItem, SessionSummary } from "./types.js";

export function generateSuggestions(blocked: BlockedItem[], sessions: SessionSummary[]): SuggestionItem[] {
  const suggestions: SuggestionItem[] = [];

  // 1. Approved RFCs not executed (highest priority)
  for (const item of blocked.filter((b) => b.type === "open_rfc")) {
    suggestions.push({
      type: "execute_rfc",
      description: `Execute approved "${item.description}" — ready to go`,
      reasoning: "RFC is approved and waiting for execution",
    });
  }

  // 2. Escalated tasks
  for (const item of blocked.filter((b) => b.type === "escalated_task")) {
    suggestions.push({
      type: "resolve_escalation",
      description: `Resolve "${item.description}" escalation`,
      reasoning: "Task was escalated and needs attention",
    });
  }

  // 3. Agent health alerts
  for (const item of blocked.filter((b) => b.type === "agent_alert")) {
    suggestions.push({
      type: "agent_health",
      description: `Consider: ${item.description} — review task routing`,
      reasoning: "Agent confidence is dropping, may need routing adjustments",
    });
  }

  // 4. Deferred tasks (lowest priority)
  for (const item of blocked.filter((b) => b.type === "deferred_task")) {
    suggestions.push({
      type: "follow_up",
      description: `Pick up deferred: ${item.description}`,
      reasoning: "Task was deferred from a previous session",
    });
  }

  // Momentum signal: if last 3 sessions share same goal domain
  if (sessions.length >= 3) {
    const last3 = sessions.slice(0, 3);
    const domains = last3.map((s) => s.goal.split(/\s+/).slice(0, 2).join(" ").toLowerCase());
    if (domains[0] && domains.every((d) => d === domains[0])) {
      suggestions.push({
        type: "follow_up",
        description: `You're on a roll with "${domains[0]}" — continue?`,
        reasoning: "Last 3 sessions share the same domain focus",
      });
    }
  }

  // Cap at 3
  return suggestions.slice(0, 3);
}
