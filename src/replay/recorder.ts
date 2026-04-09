/**
 * Session recorder — captures graph node execution and broadcast events.
 * Designed to never block or slow graph execution.
 * All writes are async fire-and-forget.
 */

import { randomUUID } from "node:crypto";
import type { RecordingEvent, BroadcastEvent } from "./types.js";

/** Lightweight alias for graph state — the recorder only serializes fields. */
type GraphState = Record<string, unknown>;
import { appendRecordingEvent, appendBroadcastEvent } from "./storage.js";

export class SessionRecorder {
  readonly sessionId: string;
  private runIndex = 0;
  private active = true;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Set the current run index for multi-run sessions. */
  setRunIndex(runIndex: number): void {
    this.runIndex = runIndex;
  }

  /** Stop recording. Subsequent calls to record are no-ops. */
  stop(): void {
    this.active = false;
  }

  /** Record a node enter event. Never throws. */
  recordNodeEnter(nodeId: string, state: GraphState): void {
    if (!this.active) return;
    try {
      const event: RecordingEvent = {
        id: randomUUID(),
        sessionId: this.sessionId,
        runIndex: this.runIndex,
        nodeId,
        phase: "enter",
        timestamp: Date.now(),
        stateBefore: extractStateSnapshot(state),
      };
      appendRecordingEvent(this.sessionId, event);
    } catch {
      // Never propagate errors from recording
    }
  }

  /** Record a node exit event with output state. Never throws. */
  recordNodeExit(
    nodeId: string,
    result: Partial<GraphState>,
    startTime: number,
    agentOutput?: RecordingEvent["agentOutput"],
  ): void {
    if (!this.active) return;
    try {
      const event: RecordingEvent = {
        id: randomUUID(),
        sessionId: this.sessionId,
        runIndex: this.runIndex,
        nodeId,
        phase: "exit",
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        stateAfter: result as Record<string, unknown>,
        agentOutput,
      };
      appendRecordingEvent(this.sessionId, event);
    } catch {
      // Never propagate errors from recording
    }
  }

  /** Record a broadcast event. Never throws. */
  recordBroadcast(event: Record<string, unknown>): void {
    if (!this.active) return;
    try {
      const entry: BroadcastEvent = {
        id: randomUUID(),
        sessionId: this.sessionId,
        timestamp: Date.now(),
        event,
      };
      appendBroadcastEvent(this.sessionId, entry);
    } catch {
      // Never propagate errors from recording
    }
  }
}

/**
 * Wrap a graph node function to automatically record enter/exit events.
 * Returns a new function with identical signature.
 */
export function wrapWithRecording(
  recorder: SessionRecorder,
  nodeName: string,
  fn: (state: GraphState) => Promise<Partial<GraphState>>,
): (state: GraphState) => Promise<Partial<GraphState>> {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const startTime = Date.now();
    recorder.recordNodeEnter(nodeName, state);
    const result = await fn(state);
    recorder.recordNodeExit(nodeName, result, startTime);
    return result;
  };
}

/**
 * Wrap a sync graph node function for recording.
 */
export function wrapSyncWithRecording(
  recorder: SessionRecorder,
  nodeName: string,
  fn: (state: GraphState) => Partial<GraphState>,
): (state: GraphState) => Partial<GraphState> {
  return (state: GraphState): Partial<GraphState> => {
    const startTime = Date.now();
    recorder.recordNodeEnter(nodeName, state);
    const result = fn(state);
    recorder.recordNodeExit(nodeName, result, startTime);
    return result;
  };
}

/** Extract a lightweight snapshot of state for recording. */
function extractStateSnapshot(state: GraphState): Record<string, unknown> {
  // Capture key fields without deep-cloning the entire state
  return {
    cycle_count: state.cycle_count,
    task_queue: state.task_queue,
    bot_stats: state.bot_stats,
    user_goal: state.user_goal,
    __node__: state.__node__,
    average_confidence: state.average_confidence,
    total_tasks: state.total_tasks,
    completed_tasks: state.completed_tasks,
    teamComposition: state.teamComposition,
    planning_document: state.planning_document ? "[present]" : null,
    architecture_document: state.architecture_document ? "[present]" : null,
    rfc_document: state.rfc_document ? "[present]" : null,
  };
}

// ---------------------------------------------------------------------------
// Module-level recorder instance (set by work-runner, used by simulation)
// ---------------------------------------------------------------------------
let activeRecorder: SessionRecorder | null = null;

export function getActiveRecorder(): SessionRecorder | null {
  return activeRecorder;
}

export function setActiveRecorder(recorder: SessionRecorder | null): void {
  activeRecorder = recorder;
}
