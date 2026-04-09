/**
 * Utilization calculator — computes per-agent utilization from recording events.
 * Read-only: never modifies recordings or state.
 */

import type { RecordingEvent } from "../replay/types.js";
import type { AgentUtilization, TaskTypeBreakdown } from "./types.js";

/** Task type keywords for classification (lightweight, no LLM). */
const TASK_TYPE_KEYWORDS: Record<string, string[]> = {
  audit: ["audit", "review", "inspect", "check", "verify"],
  research: ["research", "investigate", "analyze", "explore", "study"],
  implement: ["implement", "build", "create", "develop", "code", "write"],
  test: ["test", "validate", "assert", "spec", "coverage"],
  refactor: ["refactor", "clean", "optimize", "simplify", "restructure"],
  document: ["document", "docs", "readme", "describe", "explain"],
  design: ["design", "architect", "plan", "blueprint", "diagram"],
  debug: ["debug", "fix", "resolve", "patch", "troubleshoot"],
};

function classifyTask(description: string): string {
  const lower = description.toLowerCase();
  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return type;
  }
  return "general";
}

export interface CalculatorOptions {
  /** Bottleneck utilization threshold (default: 0.8). */
  bottleneckThreshold?: number;
}

/**
 * Compute utilization metrics for each agent from recording events.
 * Groups events by agent nodeId, computes timing, cost, and bottleneck score.
 */
export function calculateUtilization(
  sessionId: string,
  runIndex: number,
  events: RecordingEvent[],
  _options: CalculatorOptions = {},
): AgentUtilization[] {
  const runEvents = events.filter((e) => e.runIndex === runIndex);
  if (runEvents.length === 0) return [];

  // Sprint wall time
  const timestamps = runEvents.map((e) => e.timestamp);
  const sprintStart = Math.min(...timestamps);
  const sprintEnd = Math.max(...timestamps);
  const totalWallMs = Math.max(sprintEnd - sprintStart, 1);

  // Group exit events by nodeId (agent)
  const agentEvents = new Map<string, RecordingEvent[]>();
  for (const evt of runEvents) {
    if (evt.phase !== "exit") continue;
    const existing = agentEvents.get(evt.nodeId) ?? [];
    existing.push(evt);
    agentEvents.set(evt.nodeId, existing);
  }

  // Compute queue depth: count overlapping active periods
  const activeIntervals = buildActiveIntervals(runEvents);
  const maxQueueDepth = computeMaxQueueDepth(activeIntervals);

  const results: AgentUtilization[] = [];

  for (const [nodeId, exits] of agentEvents) {
    const durations = exits
      .map((e) => e.durationMs ?? 0)
      .filter((d) => d > 0);

    const totalActiveMs = durations.reduce((sum, d) => sum + d, 0);
    const tasksHandled = exits.length;
    const avgDuration = tasksHandled > 0 ? totalActiveMs / tasksHandled : 0;
    const maxDuration = durations.length > 0 ? Math.max(...durations) : 0;
    const minDuration = durations.length > 0 ? Math.min(...durations) : 0;

    // Confidence
    const confidences = exits
      .map((e) => e.agentOutput?.confidence?.score)
      .filter((c): c is number => c != null);
    const avgConfidence = confidences.length > 0
      ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
      : 0;

    // Tokens
    const tokens = exits.reduce((sum, e) => sum + (e.agentOutput?.tokensUsed ?? 0), 0);

    const utilizationPct = totalWallMs > 0 ? totalActiveMs / totalWallMs : 0;

    // Queue depth for this agent
    const agentIntervals = activeIntervals.filter((i) => i.nodeId === nodeId);
    const queueDepth = computeAgentQueueDepth(agentIntervals);

    // Bottleneck score formula
    const normalizedQueue = maxQueueDepth > 0 ? queueDepth / maxQueueDepth : 0;
    const durationRatio = avgDuration > 0 ? maxDuration / avgDuration : 0;
    const bottleneckScore = Math.min(1,
      utilizationPct * 0.5 +
      normalizedQueue * 0.3 +
      Math.min(durationRatio, 3) / 3 * 0.2,
    );

    // Task type breakdown
    const taskTypeMap = new Map<string, { count: number; totalDuration: number; totalConf: number; confCount: number }>();
    for (const evt of exits) {
      const taskQueue = (evt.stateAfter?.task_queue as Record<string, unknown>[]) ?? [];
      // Find the task this exit relates to
      const desc = taskQueue
        .map((t) => (t.description as string) ?? "")
        .find((d) => d.length > 0) ?? "";
      const taskType = classifyTask(desc);
      const entry = taskTypeMap.get(taskType) ?? { count: 0, totalDuration: 0, totalConf: 0, confCount: 0 };
      entry.count++;
      entry.totalDuration += evt.durationMs ?? 0;
      if (evt.agentOutput?.confidence?.score != null) {
        entry.totalConf += evt.agentOutput.confidence.score;
        entry.confCount++;
      }
      taskTypeMap.set(taskType, entry);
    }

    const taskTypeBreakdown: TaskTypeBreakdown[] = [];
    for (const [taskType, data] of taskTypeMap) {
      taskTypeBreakdown.push({
        taskType,
        count: data.count,
        avgDurationMs: data.count > 0 ? data.totalDuration / data.count : 0,
        avgConfidence: data.confCount > 0 ? data.totalConf / data.confCount : 0,
      });
    }

    results.push({
      agentRole: nodeId,
      sessionId,
      runIndex,
      tasksHandled,
      totalActiveMs,
      totalWallMs,
      utilizationPct: Math.round(utilizationPct * 100) / 100,
      averageDurationMs: Math.round(avgDuration),
      maxDurationMs: maxDuration,
      minDurationMs: minDuration,
      averageConfidence: Math.round(avgConfidence * 100) / 100,
      tokensUsed: tokens,
      bottleneckScore: Math.round(bottleneckScore * 100) / 100,
      queueDepth,
      taskTypeBreakdown,
    });
  }

  // Sort by utilization descending
  results.sort((a, b) => b.utilizationPct - a.utilizationPct);
  return results;
}

interface ActiveInterval {
  nodeId: string;
  start: number;
  end: number;
}

function buildActiveIntervals(events: RecordingEvent[]): ActiveInterval[] {
  const intervals: ActiveInterval[] = [];
  const enterTimes = new Map<string, number[]>();

  for (const evt of events) {
    if (evt.phase === "enter") {
      const existing = enterTimes.get(evt.nodeId) ?? [];
      existing.push(evt.timestamp);
      enterTimes.set(evt.nodeId, existing);
    } else if (evt.phase === "exit" && evt.durationMs) {
      intervals.push({
        nodeId: evt.nodeId,
        start: evt.timestamp - evt.durationMs,
        end: evt.timestamp,
      });
    }
  }
  return intervals;
}

function computeMaxQueueDepth(intervals: ActiveInterval[]): number {
  if (intervals.length === 0) return 0;

  const points: { time: number; delta: number }[] = [];
  for (const i of intervals) {
    points.push({ time: i.start, delta: 1 });
    points.push({ time: i.end, delta: -1 });
  }
  points.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let current = 0;
  let max = 0;
  for (const p of points) {
    current += p.delta;
    if (current > max) max = current;
  }
  return max;
}

function computeAgentQueueDepth(intervals: ActiveInterval[]): number {
  return computeMaxQueueDepth(intervals);
}
