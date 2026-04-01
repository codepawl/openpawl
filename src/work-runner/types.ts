/**
 * Shared types for work-runner modules.
 */

import type { BotDefinition } from "../core/bot-definitions.js";
import type { VectorMemory } from "../core/knowledge-base.js";
import type { GraphState } from "../core/graph-state.js";
import type { TeamComposition } from "../agents/composition/types.js";

/** Everything needed by run-loop and cleanup modules. */
export interface SessionContext {
  sessionId: string;
  goal: string;
  workspacePath: string;
  team: BotDefinition[];
  vectorMemory: VectorMemory;
  maxRuns: number;
  timeoutMinutes: number;
  sessionMode: "runs" | "time";
  noInteractive: boolean;
  canRenderSpinner: boolean;
  sessionAbort: AbortController;
  autoApprove: boolean;
  noPreview: boolean;
  asyncMode: boolean;
  asyncTimeout: number;
  noStream: boolean;
  noWebFlag: boolean;
  setupConfig: Record<string, unknown>;
  teamMode: "manual" | "autonomous" | "template" | undefined;
  templateId: string | undefined;
}

/** Output of a single run cycle. */
export interface RunResult {
  success: boolean;
  finalState: GraphState | null;
  reworkCount: number;
  errorMessage?: string;
  retryable: boolean;
  elapsedMs: number;
  tasksCompleted: number;
  totalTasks: number;
}

/** Accumulated stats across all runs. */
export interface WorkStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  longestRunMs: number;
  totalTasks: number;
  lastFinalState: GraphState | null;
  lastTeamComposition: TeamComposition | null;
}

/** Errors thrown to signal user cancellation (exit code 0). */
export class UserCancelError extends Error {
  constructor(message = "Work session cancelled.") {
    super(message);
    this.name = "UserCancelError";
  }
}

/** Errors thrown to signal fatal session failures (exit code 1). */
export class FatalSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalSessionError";
  }
}
