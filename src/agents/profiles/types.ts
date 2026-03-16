/**
 * Types for agent performance profiles.
 */

export type TaskType =
  | "audit"
  | "research"
  | "implement"
  | "test"
  | "refactor"
  | "document"
  | "design"
  | "debug"
  | "general";

export interface TaskTypeScore {
  taskType: TaskType;
  averageConfidence: number;
  successRate: number;
  averageReworkCount: number;
  totalTasksCompleted: number;
  trend: "improving" | "stable" | "degrading";
}

export interface AgentProfile {
  agentRole: string;
  taskTypeScores: TaskTypeScore[];
  overallScore: number;
  strengths: string[];
  weaknesses: string[];
  lastUpdatedAt: number;
  totalTasksCompleted: number;
  scoreHistory: number[];
}

export interface RoutingDecision {
  taskId: string;
  assignedAgent: string;
  reason: string;
  alternativeAgents: Array<{ role: string; score: number }>;
  profileConfidence: number;
}

export interface ProfileAlert {
  agentRole: string;
  previousScore: number;
  currentScore: number;
  alertAt: number;
}

export type ConfidenceGate = "USE_PROFILE" | "PARTIAL_WEIGHT" | "IGNORE_PROFILE";

export const PROFILE_CONFIDENCE_THRESHOLDS = {
  USE_PROFILE: 10,
  PARTIAL_WEIGHT: 5,
  IGNORE_PROFILE: 0,
} as const;

export interface CompletedTaskResult {
  taskId: string;
  agentRole: string;
  description: string;
  success: boolean;
  confidence: number;
  reworkCount: number;
}
