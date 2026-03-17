/**
 * Types for session briefing data.
 */

export interface LastSessionInfo {
  sessionId: string;
  goal: string;
  completedAt: number;
  daysAgo: number;
  totalCostUSD: number;
  tasksCompleted: number;
}

export interface LeftOpenItem {
  taskDescription: string;
  reason: "escalated" | "deferred" | "failed";
  sessionId: string;
}

export interface TeamPerformanceEntry {
  agentRole: string;
  trend: "improving" | "stable" | "degrading";
  confidenceDelta: number;
  alert: boolean;
}

export interface RelevantDecision {
  decision: string;
  recommendedBy: string;
  date: string;
}

export interface BriefingData {
  lastSession: LastSessionInfo | null;
  whatWasBuilt: string[];
  teamLearnings: string[];
  leftOpen: LeftOpenItem[];
  teamPerformance: TeamPerformanceEntry[];
  newGlobalPatterns: number;
  openRFCs: string[];
  relevantDecisions: RelevantDecision[];
}

export interface InterRunSummary {
  completedRun: number;
  nextRun: number;
  averageConfidence: number;
  targetConfidence: number;
  newLessons: number;
}
