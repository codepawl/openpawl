/**
 * Types for agent utilization heatmap.
 */

export interface AgentUtilization {
  agentRole: string;
  sessionId: string;
  runIndex: number;
  tasksHandled: number;
  totalActiveMs: number;
  totalWallMs: number;
  utilizationPct: number;
  averageDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
  averageConfidence: number;
  tokensUsed: number;
  bottleneckScore: number;
  queueDepth: number;
  taskTypeBreakdown: TaskTypeBreakdown[];
}

export interface TaskTypeBreakdown {
  taskType: string;
  count: number;
  avgDurationMs: number;
  avgConfidence: number;
}

export type HeatmapScope = "run" | "session" | "global";
export type HeatmapMetric = "duration" | "cost" | "confidence";
export type HeatmapViewType = "task" | "time_bucket" | "run";

export interface HeatmapData {
  sessionId: string;
  runIndex?: number;
  scope: HeatmapScope;
  rows: HeatmapRow[];
  columns: HeatmapColumn[];
  cells: HeatmapCell[][];
  bottlenecks: BottleneckAlert[];
  suggestions: OptimizationSuggestion[];
}

export interface HeatmapRow {
  agentRole: string;
  displayName: string;
  overallUtilization: number;
  isBottleneck: boolean;
}

export interface HeatmapColumn {
  id: string;
  label: string;
  type: HeatmapViewType;
}

export interface HeatmapCell {
  agentRole: string;
  columnId: string;
  value: number;
  displayValue: string;
  metric: HeatmapMetric;
}

export interface BottleneckAlert {
  agentRole: string;
  utilizationPct: number;
  queueDepth: number;
  impactedTasks: string[];
  estimatedDelayMs: number;
}

export type SuggestionType = "reassign" | "parallelize" | "swap_model" | "exclude_agent";

export interface OptimizationSuggestion {
  type: SuggestionType;
  agentRole: string;
  suggestion: string;
  estimatedImpact: string;
}

export interface GlobalUtilizationEntry {
  agentRole: string;
  sessionId: string;
  runIndex: number;
  recordedAt: number;
  utilizationPct: number;
  bottleneckScore: number;
  averageConfidence: number;
  tasksHandled: number;
}
