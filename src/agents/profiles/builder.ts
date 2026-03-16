/**
 * ProfileBuilder — builds/updates agent profiles from completed task results.
 * Runs post-run to aggregate performance data across sessions.
 */

import type { AgentProfile, CompletedTaskResult, TaskType, TaskTypeScore } from "./types.js";
import { classifyTaskType } from "./classifier.js";
import type { ProfileStore } from "./store.js";
import { logger, isDebugMode } from "../../core/logger.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.info(msg);
  }
}

const MAX_SCORE_HISTORY = 20;
const STRENGTH_THRESHOLD = 0.85;
const WEAKNESS_THRESHOLD = 0.5;
const MIN_TASKS_FOR_LABEL = 5;
const TREND_THRESHOLD = 0.02;
const DECAY_SUCCESS_FACTOR = 1.02;
const DECAY_FAILURE_FACTOR = 0.95;

interface TaskGroup {
  taskType: TaskType;
  results: CompletedTaskResult[];
}

export class ProfileBuilder {
  private readonly store: ProfileStore;

  constructor(store: ProfileStore) {
    this.store = store;
  }

  async buildFromTaskResults(results: CompletedTaskResult[]): Promise<AgentProfile[]> {
    if (results.length === 0) return [];

    // Group by agentRole
    const byRole = new Map<string, CompletedTaskResult[]>();
    for (const r of results) {
      const existing = byRole.get(r.agentRole) ?? [];
      existing.push(r);
      byRole.set(r.agentRole, existing);
    }

    const updatedProfiles: AgentProfile[] = [];

    for (const [role, roleResults] of byRole) {
      const existing = await this.store.getByRole(role);
      const profile = await this.buildProfileForRole(role, roleResults, existing);
      await this.store.upsert(profile);
      updatedProfiles.push(profile);
      log(`Updated profile for ${role}: score=${profile.overallScore.toFixed(3)}, tasks=${profile.totalTasksCompleted}`);
    }

    return updatedProfiles;
  }

  private async buildProfileForRole(
    role: string,
    newResults: CompletedTaskResult[],
    existing: AgentProfile | null,
  ): Promise<AgentProfile> {
    // Classify and group new results by task type
    const taskGroups = this.groupByTaskType(newResults);

    // Merge with existing task type scores
    const existingScoresMap = new Map<TaskType, TaskTypeScore>();
    if (existing) {
      for (const s of existing.taskTypeScores) {
        existingScoresMap.set(s.taskType, s);
      }
    }

    const updatedScores: TaskTypeScore[] = [];

    for (const group of taskGroups) {
      const prev = existingScoresMap.get(group.taskType);
      const updated = this.mergeTaskTypeScore(prev ?? null, group);
      updatedScores.push(updated);
      existingScoresMap.delete(group.taskType);
    }

    // Keep scores for task types not in this batch
    for (const remaining of existingScoresMap.values()) {
      updatedScores.push(remaining);
    }

    // Compute overall score with decay
    const existingScore = existing?.overallScore ?? 0.5;
    let overallScore = existingScore;
    for (const r of newResults) {
      if (r.success) {
        overallScore = Math.min(1.0, overallScore * DECAY_SUCCESS_FACTOR);
      } else {
        overallScore = overallScore * DECAY_FAILURE_FACTOR;
      }
    }

    // Derive strengths and weaknesses
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    for (const s of updatedScores) {
      if (s.totalTasksCompleted >= MIN_TASKS_FOR_LABEL) {
        if (s.successRate >= STRENGTH_THRESHOLD) {
          strengths.push(s.taskType);
        }
        if (s.successRate < WEAKNESS_THRESHOLD) {
          weaknesses.push(s.taskType);
        }
      }
    }

    // Update score history
    const scoreHistory = [...(existing?.scoreHistory ?? []), overallScore].slice(-MAX_SCORE_HISTORY);

    const totalPrev = existing?.totalTasksCompleted ?? 0;

    return {
      agentRole: role,
      taskTypeScores: updatedScores,
      overallScore,
      strengths,
      weaknesses,
      lastUpdatedAt: Date.now(),
      totalTasksCompleted: totalPrev + newResults.length,
      scoreHistory,
    };
  }

  private groupByTaskType(results: CompletedTaskResult[]): TaskGroup[] {
    const map = new Map<TaskType, CompletedTaskResult[]>();
    for (const r of results) {
      const taskType = classifyTaskType(r.description);
      const existing = map.get(taskType) ?? [];
      existing.push(r);
      map.set(taskType, existing);
    }
    return Array.from(map.entries()).map(([taskType, results]) => ({ taskType, results }));
  }

  private mergeTaskTypeScore(prev: TaskTypeScore | null, group: TaskGroup): TaskTypeScore {
    const prevCount = prev?.totalTasksCompleted ?? 0;
    const newCount = group.results.length;
    const totalCount = prevCount + newCount;

    // Running average for confidence
    const prevConfSum = (prev?.averageConfidence ?? 0) * prevCount;
    const newConfSum = group.results.reduce((sum, r) => sum + r.confidence, 0);
    const averageConfidence = totalCount > 0 ? (prevConfSum + newConfSum) / totalCount : 0;

    // Running average for success rate
    const prevSuccessCount = Math.round((prev?.successRate ?? 0) * prevCount);
    const newSuccessCount = group.results.filter((r) => r.success).length;
    const successRate = totalCount > 0 ? (prevSuccessCount + newSuccessCount) / totalCount : 0;

    // Running average for rework count
    const prevReworkSum = (prev?.averageReworkCount ?? 0) * prevCount;
    const newReworkSum = group.results.reduce((sum, r) => sum + r.reworkCount, 0);
    const averageReworkCount = totalCount > 0 ? (prevReworkSum + newReworkSum) / totalCount : 0;

    // Trend: compare current vs previous averageConfidence
    const prevConf = prev?.averageConfidence ?? 0;
    const delta = averageConfidence - prevConf;
    let trend: "improving" | "stable" | "degrading" = "stable";
    if (prev && prevCount > 0) {
      if (delta > TREND_THRESHOLD) trend = "improving";
      else if (delta < -TREND_THRESHOLD) trend = "degrading";
    }

    return {
      taskType: group.taskType,
      averageConfidence,
      successRate,
      averageReworkCount,
      totalTasksCompleted: totalCount,
      trend,
    };
  }
}
