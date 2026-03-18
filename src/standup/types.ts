/**
 * Types for standup command data structures.
 */

export interface StandupData {
  date: string;
  yesterday: {
    sessions: SessionSummary[];
    totalCostUSD: number;
    totalTasks: number;
    teamLearnings: string[];
  };
  blocked: BlockedItem[];
  suggested: SuggestionItem[];
  streak: number;
  weekCostUSD: number;
  globalPatternsCount: number;
}

export interface SessionSummary {
  sessionId: string;
  goal: string;
  tasksCompleted: number;
  reworkCount: number;
  allApproved: boolean;
  costUSD: number;
}

export interface BlockedItem {
  type: "open_rfc" | "escalated_task" | "agent_alert" | "deferred_task";
  description: string;
  sessionId: string;
  priority: "high" | "medium" | "low";
}

export interface SuggestionItem {
  type: "execute_rfc" | "resolve_escalation" | "follow_up" | "agent_health";
  description: string;
  reasoning: string;
  estimatedCost?: number;
}

export interface StreakEntry {
  date: string;
  sessionCount: number;
  totalCostUSD: number;
  recordedAt: number;
}

export interface WeeklySummary {
  weekLabel: string;
  sessionCount: number;
  activeDays: number;
  tasksCompleted: number;
  autoApproved: number;
  reworkCount: number;
  totalCostUSD: number;
  avgConfidence: number;
  prevWeekAvgConfidence: number | null;
  newGlobalPatterns: number;
  newSessionPatterns: number;
  topDomains: { domain: string; taskCount: number }[];
  bestDay: { dayLabel: string; taskCount: number; costUSD: number; avgConfidence: number } | null;
  streak: number;
}

export type StandupTimeWindow = {
  since: number;
  label: string;
};
