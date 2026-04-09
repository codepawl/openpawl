/**
 * Run diff engine — compares two GraphState snapshots and produces a structured RunDiff.
 * Never modifies session recordings or state. Read-only.
 */

import type {
  RunDiff,
  TaskDiff,
  MetricDiff,
  MemoryDiff,
  RoutingDiff,
  TeamDiff,
  RunSnapshot,
  TaskSnapshot,
} from "./types.js";
import { matchTasks } from "./matcher.js";

/** Compute a RunDiff from two run snapshots. */
export function computeRunDiff(from: RunSnapshot, to: RunSnapshot): RunDiff {
  const { matched, added, removed } = matchTasks(from.tasks, to.tasks);

  const taskDiffs: TaskDiff[] = [];

  // Matched tasks — check for changes
  for (const { fromTask, toTask } of matched) {
    const confidenceDelta = toTask.confidence - fromTask.confidence;
    const reworkCountDelta = toTask.reworkCount - fromTask.reworkCount;
    const durationDelta = toTask.durationMs - fromTask.durationMs;

    const agentChanged = fromTask.assignedTo !== toTask.assignedTo
      ? { from: fromTask.assignedTo, to: toTask.assignedTo }
      : undefined;

    const approvalChanged = fromTask.approvalStatus !== toTask.approvalStatus
      ? { from: fromTask.approvalStatus, to: toTask.approvalStatus }
      : undefined;

    const hasChanges =
      Math.abs(confidenceDelta) > 0.001 ||
      reworkCountDelta !== 0 ||
      agentChanged !== undefined ||
      approvalChanged !== undefined ||
      Math.abs(durationDelta) > 100;

    taskDiffs.push({
      taskId: toTask.taskId,
      description: toTask.description,
      status: hasChanges ? "changed" : "unchanged",
      confidenceDelta: Math.round(confidenceDelta * 100) / 100,
      reworkCountDelta,
      agentChanged,
      approvalChanged,
      durationDelta,
    });
  }

  // Added tasks
  for (const task of added) {
    taskDiffs.push({
      taskId: task.taskId,
      description: task.description,
      status: "added",
      confidenceDelta: task.confidence,
    });
  }

  // Removed tasks
  for (const task of removed) {
    taskDiffs.push({
      taskId: task.taskId,
      description: task.description,
      status: "removed",
    });
  }

  const metricDiffs = computeMetricDiffs(from, to, added.length, removed.length);
  const memoryDiff = computeMemoryDiff(from, to);
  const routingDiffs = computeRoutingDiffs(matched);
  const teamDiff = computeTeamDiff(from.team, to.team);

  return {
    sessionId: from.sessionId,
    fromRun: from.runIndex,
    toRun: to.runIndex,
    taskDiffs,
    metricDiffs,
    memoryDiff,
    routingDiffs,
    teamDiff,
  };
}

function computeMetricDiffs(
  from: RunSnapshot,
  to: RunSnapshot,
  addedCount: number,
  removedCount: number,
): MetricDiff {
  return {
    averageConfidenceDelta: Math.round((to.averageConfidence - from.averageConfidence) * 100) / 100,
    totalDurationDelta: to.totalDurationMs - from.totalDurationMs,
    reworkCountDelta: to.totalReworks - from.totalReworks,
    autoApprovedDelta: to.autoApprovedCount - from.autoApprovedCount,
    tasksAddedCount: addedCount,
    tasksRemovedCount: removedCount,
  };
}

function computeMemoryDiff(from: RunSnapshot, to: RunSnapshot): MemoryDiff {
  return {
    patternsRetrievedDelta: to.patternsRetrieved - from.patternsRetrieved,
    newPatternsStoredDelta: to.newPatternsStored - from.newPatternsStored,
    globalPromotionsDelta: to.globalPromotions - from.globalPromotions,
    lessonsApplied: to.lessonsApplied,
  };
}

function computeRoutingDiffs(
  matched: { fromTask: TaskSnapshot; toTask: TaskSnapshot }[],
): RoutingDiff[] {
  const diffs: RoutingDiff[] = [];
  for (const { fromTask, toTask } of matched) {
    if (fromTask.assignedTo !== toTask.assignedTo) {
      diffs.push({
        taskId: toTask.taskId,
        fromAgent: fromTask.assignedTo,
        toAgent: toTask.assignedTo,
        reason: fromTask.confidence < 0.6
          ? "low confidence triggered re-routing"
          : "profile-based optimization",
      });
    }
  }
  return diffs;
}

function computeTeamDiff(fromTeam: string[], toTeam: string[]): TeamDiff {
  const fromSet = new Set(fromTeam);
  const toSet = new Set(toTeam);

  return {
    agentsAdded: toTeam.filter((a) => !fromSet.has(a)),
    agentsRemoved: fromTeam.filter((a) => !toSet.has(a)),
    unchanged: fromTeam.filter((a) => toSet.has(a)),
  };
}

/** Extract a RunSnapshot from a GraphState record. */
export function extractRunSnapshot(
  sessionId: string,
  runIndex: number,
  state: Record<string, unknown>,
  startedAt: number,
  completedAt: number,
): RunSnapshot {
  const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
  const approvalStats = (state.approval_stats ?? {}) as Record<string, unknown>;
  const memContext = (state.memory_context ?? {}) as Record<string, unknown>;
  const newPatterns = (state.new_success_patterns as string[]) ?? [];
  const promoted = (state.promoted_this_run as string[]) ?? [];
  const team = (state.team ?? []) as Record<string, unknown>[];
  const teamComp = (state.teamComposition as Record<string, unknown>) ?? {};
  const successPatterns = (memContext.successPatterns as unknown[]) ?? [];
  const failureLessons = (memContext.failureLessons as unknown[]) ?? [];

  const tasks: TaskSnapshot[] = taskQueue.map((t) => {
    const result = (t.result as Record<string, unknown>) ?? {};
    const confidence = result.confidence as Record<string, unknown> | undefined;
    const routing = (result.routing_decision as string) ?? "";

    return {
      taskId: (t.task_id as string) ?? "",
      description: (t.description as string) ?? "",
      assignedTo: (t.assigned_to as string) ?? "",
      status: (t.status as string) ?? "",
      confidence: (confidence?.score as number) ?? 0,
      reworkCount: (t.retry_count as number) ?? 0,
      approvalStatus: routing || ((t.status as string) ?? ""),
      durationMs: (t.timebox_minutes as number) ?? 0,
    };
  });

  const avgConfidence = (state.average_confidence as number) ?? 0;
  const autoApproved = (approvalStats.autoApprovedCount as number) ?? 0;
  const totalReworks = tasks.reduce((sum, t) => sum + t.reworkCount, 0);

  // Team names from team array or teamComposition
  const teamNames: string[] = team.length > 0
    ? team.map((t) => (t.role_id as string) ?? (t.name as string) ?? "")
    : ((teamComp as Record<string, unknown>).activeAgents as Record<string, unknown>[])
        ?.map((a) => (a.role as string) ?? "")
        ?? [];

  // Lessons applied from memory context
  const lessonsApplied: string[] = [];
  for (const pattern of successPatterns) {
    const p = pattern as Record<string, unknown>;
    if (p.taskDescription) lessonsApplied.push(p.taskDescription as string);
  }

  return {
    sessionId,
    runIndex,
    tasks,
    averageConfidence: avgConfidence,
    totalDurationMs: completedAt - startedAt,
    totalReworks,
    autoApprovedCount: autoApproved,
    team: teamNames.filter(Boolean),
    patternsRetrieved: successPatterns.length + failureLessons.length,
    newPatternsStored: newPatterns.length,
    globalPromotions: promoted.length,
    lessonsApplied,
  };
}
