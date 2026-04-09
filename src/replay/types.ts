/**
 * Types for session recording, replay, and patching.
 */

/** Confidence score from a completed task. */
export interface ConfidenceScore {
  score: number;
  reasoning: string;
  flags: string[];
}

/** Routing decision based on confidence thresholds. */
export type RoutingDecision = "auto_approved" | "qa_review" | "rework" | "escalated";

/** A single recorded event from graph execution. */
export interface RecordingEvent {
  id: string;
  sessionId: string;
  runIndex: number;
  nodeId: string;
  phase: "enter" | "exit";
  timestamp: number;
  durationMs?: number;
  stateBefore?: Record<string, unknown>;
  stateAfter?: Record<string, unknown>;
  agentOutput?: {
    prompt: string;
    rawOutput: string;
    confidence?: ConfidenceScore;
    tokensUsed: number;
  };
  routingDecision?: RoutingDecision;
}

/** A broadcast event captured during recording. */
export interface BroadcastEvent {
  id: string;
  sessionId: string;
  timestamp: number;
  event: Record<string, unknown>;
}

/** Session index entry stored in index.json. */
export interface SessionIndexEntry {
  sessionId: string;
  goal: string;
  createdAt: number;
  completedAt: number;
  totalRuns: number;
  averageConfidence: number;
  recordingPath: string;
  recordingSizeBytes: number;
  teamComposition: string[];
  tag?: string;
}

/** Options for replay playback. */
export interface ReplayOptions {
  sessionId: string;
  runIndex?: number;
  fromNode?: string;
  speed: number;
  patch?: ReplayPatch[];
  liveAfter?: boolean;
}

/** A single patch to apply during replay. */
export interface ReplayPatch {
  nodeId: string;
  taskId?: string;
  promptOverride?: string;
  outputOverride?: string | null;
}

/** Patch file format loaded from disk. */
export interface PatchFile {
  patches: ReplayPatch[];
}

/** Diff result comparing two sessions. */
export interface SessionDiff {
  sessionA: string;
  sessionB: string;
  goalSame: boolean;
  goalA: string;
  goalB: string;
  teamSame: boolean;
  teamA: string[];
  teamB: string[];
  taskCountA: number;
  taskCountB: number;
  avgConfidenceA: number;
  avgConfidenceB: number;
  durationA: number;
  durationB: number;
  changedNodes: NodeDiff[];
}

/** A single node difference between two sessions. */
export interface NodeDiff {
  nodeId: string;
  changeType: "added" | "removed" | "modified";
  details: string;
}
