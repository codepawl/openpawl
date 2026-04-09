/**
 * Session state type definitions and factory.
 * Single source of truth for everything in one conversation.
 */

import { randomUUID } from "node:crypto";

/** Generate a short URL-safe ID (12 chars from UUID). */
export function shortId(len = 12): string {
  return randomUUID().replace(/-/g, "").slice(0, len);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "active"       // user is interacting
  | "idle"         // no activity for idleTimeoutMinutes
  | "archived"     // explicitly archived by user or auto-archived
  | "crashed"      // unclean shutdown detected
  | "recovering";  // crash recovery in progress

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  agentId?: string;
  toolCallId?: string;
  timestamp: string;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool tracking
// ---------------------------------------------------------------------------

export type ToolExecutionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "completed"
  | "failed";

export interface ToolExecution {
  id: string;
  toolName: string;
  agentId: string;
  input: unknown;
  output: unknown;
  status: ToolExecutionStatus;
  duration: number;
  timestamp: string;
}

export interface ToolConfirmation {
  executionId: string;
  toolName: string;
  agentId: string;
  description: string;
  risk: "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// File tracking
// ---------------------------------------------------------------------------

export interface FileModification {
  path: string;
  operation: "created" | "modified" | "deleted";
  agentId: string;
  timestamp: string;
  snapshotPath?: string;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface SessionState {
  // Identity
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;

  // Conversation
  messages: SessionMessage[];
  messageCount: number;

  // Agent context
  activeAgents: string[];
  agentStates: Record<string, unknown>;

  // Tool tracking
  toolExecutions: ToolExecution[];
  pendingConfirmations: ToolConfirmation[];

  // File context
  workingDirectory: string;
  trackedFiles: string[];
  modifiedFiles: FileModification[];

  // Token metrics
  totalInputTokens: number;
  totalOutputTokens: number;
  providerBreakdown: Record<string, { tokens: number }>;

  // Compression
  compressionCheckpoint: number;
  compressedSummary: string | null;

  // Recovery
  lastCheckpointAt: string;
  checkpointVersion: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SessionError =
  | { type: "not_found"; id: string }
  | { type: "invalid_status"; current: SessionStatus; expected: SessionStatus[] }
  | { type: "confirmation_not_found"; executionId: string }
  | { type: "serialization_failed"; cause: string }
  | { type: "recovery_failed"; cause: string }
  | { type: "io_failed"; cause: string };

// ---------------------------------------------------------------------------
// List item (lightweight, for index)
// ---------------------------------------------------------------------------

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  status: SessionStatus;
  messageCount: number;
  workingDirectory: string;
  preview: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmptySession(workingDirectory: string): SessionState {
  const now = new Date().toISOString();
  return {
    id: shortId(12),
    title: "New session",
    createdAt: now,
    updatedAt: now,
    status: "active",
    messages: [],
    messageCount: 0,
    activeAgents: [],
    agentStates: {},
    toolExecutions: [],
    pendingConfirmations: [],
    workingDirectory,
    trackedFiles: [],
    modifiedFiles: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    providerBreakdown: {},
    compressionCheckpoint: 0,
    compressedSummary: null,
    lastCheckpointAt: now,
    checkpointVersion: 0,
  };
}
