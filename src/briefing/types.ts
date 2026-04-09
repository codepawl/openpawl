/**
 * Types for session briefing data.
 */

export interface LastSessionInfo {
  sessionId: string;
  goal: string;
  completedAt: number;
  daysAgo: number;
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

export interface RecentThinkSession {
  question: string;
  recommendation: string;
  savedToJournal: boolean;
  date: string;
}

export interface AsyncThinkBriefing {
  jobId: string;
  question: string;
  recommendation: string;
  confidence: number;
  completedAt: number;
  savedToJournal: boolean;
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
  recentThinkSessions?: RecentThinkSession[];
  asyncThinkResults?: AsyncThinkBriefing[];
  contextFileFound?: boolean;
  vibeScore?: { overall: number; delta: number | null; direction: string };
  standupSummary?: { sessionCount: number; topBlocked: string | null; topSuggestion: string | null };
  cacheStats?: { hitRate: number };
}

export interface InterRunSummary {
  completedRun: number;
  nextRun: number;
  averageConfidence: number;
  targetConfidence: number;
  newLessons: number;
}
