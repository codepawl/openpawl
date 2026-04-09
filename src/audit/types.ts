/**
 * Types for audit trail export.
 */

export interface PersonalityEventSummary {
  agentRole: string;
  eventType: string;
  content: string;
  severity: string | null;
  timestamp: number;
}

export interface AuditTrail {
  sessionId: string;
  runIndex: number;
  goal: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  teamComposition: string[];
  summary: AuditSummary;
  decisionLog: DecisionEntry[];
  approvalHistory: ApprovalEntry[];
  costBreakdown: CostEntry[];
  memoryUsage: MemoryUsageEntry;
  agentPerformance: AgentPerformanceEntry[];
  personalityEvents?: PersonalityEventSummary[];
  vibeScore?: {
    overall: number;
    teamTrust: number;
    reviewEngagement: number;
    warningResponse: number;
    confidenceAlignment: number;
    patterns: string[];
    tip: string;
  };
  cachePerformance?: {
    hitRate: number;
    entriesUsed: number;
    timeSavedMs: number;
  };
  providerStats?: {
    [key: string]: { requests: number; failures: number } | number;
    fallbacksTriggered: number;
  };
}

export interface AuditSummary {
  tasksCompleted: number;
  tasksFailed: number;
  autoApproved: number;
  userApproved: number;
  rejected: number;
  escalated: number;
  averageConfidence: number;
  totalTokensInput: number;
  totalTokensOutput: number;
}

export interface DecisionEntry {
  timestamp: number;
  nodeId: string;
  phase: string;
  decision: string;
  data: Record<string, unknown>;
}

export interface ApprovalEntry {
  taskId: string;
  action: string;
  by: string;
  at: number;
  feedback: string | null;
  confidence?: number;
  routingDecision?: string;
}

export interface CostEntry {
  agent: string;
  tasks: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface MemoryUsageEntry {
  successPatternsRetrieved: number;
  failureLessonsRetrieved: number;
  newPatternsStored: number;
  globalPatternsPromoted: number;
}

export interface AgentPerformanceEntry {
  agent: string;
  roleId: string;
  tasks: number;
  avgConfidence: number;
  vsProfile: number | null;
  trend: "up" | "down" | "stable";
}

export interface AuditSectionConfig {
  decisionLog: boolean;
  approvalHistory: boolean;
  costBreakdown: boolean;
  memoryUsage: boolean;
  agentPerformance: boolean;
  rawPrompts: boolean;
  personality: boolean;
}

export interface AuditConfig {
  autoExport: boolean;
  format: "markdown" | "pdf" | "both";
  includeSections: AuditSectionConfig;
}

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  autoExport: true,
  format: "markdown",
  includeSections: {
    decisionLog: true,
    approvalHistory: true,
    costBreakdown: true,
    memoryUsage: true,
    agentPerformance: true,
    rawPrompts: false,
    personality: true,
  },
};

export interface MultiRunSummary {
  sessionId: string;
  totalRuns: number;
  runs: AuditTrail[];
  confidenceTrend: number[];
  patternsPromoted: string[];
  totalDurationMs: number;
}
