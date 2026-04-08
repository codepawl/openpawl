/**
 * Types for goal diff — comparing runs within and across sessions.
 */

export type TaskDiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface TaskDiff {
  taskId: string;
  description: string;
  status: TaskDiffStatus;
  confidenceDelta?: number;
  reworkCountDelta?: number;
  agentChanged?: { from: string; to: string };
  approvalChanged?: { from: string; to: string };
  durationDelta?: number;
  costDelta?: number;
}

export interface MetricDiff {
  averageConfidenceDelta: number;
  totalCostDelta: number;
  totalTokenDelta?: number;
  totalDurationDelta: number;
  reworkCountDelta: number;
  autoApprovedDelta: number;
  tasksAddedCount: number;
  tasksRemovedCount: number;
}

export interface MemoryDiff {
  patternsRetrievedDelta: number;
  newPatternsStoredDelta: number;
  globalPromotionsDelta: number;
  lessonsApplied: string[];
}

export interface RoutingDiff {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  reason: string;
}

export interface TeamDiff {
  agentsAdded: string[];
  agentsRemoved: string[];
  unchanged: string[];
}

export interface RunDiff {
  sessionId: string;
  fromRun: number;
  toRun: number;
  taskDiffs: TaskDiff[];
  metricDiffs: MetricDiff;
  memoryDiff: MemoryDiff;
  routingDiffs: RoutingDiff[];
  teamDiff: TeamDiff;
}

export type Trend = "improving" | "stable" | "degrading";

export interface OverallTrend {
  confidenceTrend: Trend;
  costTrend: Trend;
  learningEfficiency: number;
  plateauDetected: boolean;
  plateauMessage?: string;
}

export interface DiffChain {
  sessionId: string;
  totalRuns: number;
  runDiffs: RunDiff[];
  overallTrend: OverallTrend;
}

export interface CrossSessionDiff {
  diff: RunDiff;
  configDifferences: ConfigDifference[];
  memoryContextDifference: {
    patternsAvailableA: number;
    patternsAvailableB: number;
  };
}

export interface ConfigDifference {
  key: string;
  valueA: string;
  valueB: string;
}

/** Normalized task snapshot extracted from GraphState for diffing. */
export interface TaskSnapshot {
  taskId: string;
  description: string;
  assignedTo: string;
  status: string;
  confidence: number;
  reworkCount: number;
  approvalStatus: string;
  durationMs: number;
  costUSD: number;
}

/** Normalized run snapshot for diffing. */
export interface RunSnapshot {
  sessionId: string;
  runIndex: number;
  tasks: TaskSnapshot[];
  averageConfidence: number;
  totalCostUSD: number;
  totalDurationMs: number;
  totalReworks: number;
  autoApprovedCount: number;
  team: string[];
  patternsRetrieved: number;
  newPatternsStored: number;
  globalPromotions: number;
  lessonsApplied: string[];
}

export interface TaskMatch {
  fromTask: TaskSnapshot;
  toTask: TaskSnapshot;
  matchType: "exact" | "fuzzy";
}
