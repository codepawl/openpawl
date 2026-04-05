/**
 * Tool execution audit trail types (separate from sprint audit).
 */

import type { ToolCategory, PermissionLevel } from "../tools/types.js";

export interface ToolAuditEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  toolName: string;
  toolDisplayName: string;
  category: ToolCategory;
  operation: string;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  exitCode?: number;
  duration: number;
  permissionLevel: PermissionLevel;
  userApproved?: boolean;
  filesModified: string[];
  filesRead: string[];
  networkRequests: string[];
  injectionAlerts: number;
  chainAlerts: number;
}

export interface ToolAuditQuery {
  sessionId?: string;
  agentId?: string;
  toolName?: string;
  category?: ToolCategory;
  success?: boolean;
  since?: string;
  until?: string;
  hasAlerts?: boolean;
  limit?: number;
}

export interface ToolAuditStats {
  totalEntries: number;
  byTool: Record<string, number>;
  byAgent: Record<string, number>;
  byCategory: Record<string, number>;
  successRate: number;
  averageDuration: number;
  totalAlerts: number;
  filesModifiedCount: number;
  topModifiedFiles: Array<{ path: string; count: number }>;
}

export type ToolAlertType =
  | "high_frequency"
  | "sensitive_file_access"
  | "suspicious_chain"
  | "repeated_failure";

export interface ToolAuditAlert {
  severity: "info" | "warning" | "critical";
  type: ToolAlertType;
  message: string;
  entries: string[];
}
