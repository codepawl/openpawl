/**
 * Standup data collector — gathers session history, blocked items,
 * suggestions, streak, and weekly summaries from local storage.
 *
 * No LLM calls. All data comes from session index, recordings, and memory.
 * Never throws — wraps all data access in try/catch and returns partial data.
 */

import os from "node:os";
import path from "node:path";
import { listSessions } from "../replay/session-index.js";
import { readRecordingEvents } from "../replay/storage.js";
import type { SessionIndexEntry } from "../replay/types.js";
import type {
  StandupData,
  StandupTimeWindow,
  SessionSummary,
  BlockedItem,
  SuggestionItem,
  WeeklySummary,
} from "./types.js";

/**
 * Collect standup data for a given time window.
 */
export async function collectStandupData(window: StandupTimeWindow): Promise<StandupData> {
  const result: StandupData = {
    date: new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    yesterday: {
      sessions: [],
      totalTasks: 0,
      teamLearnings: [],
    },
    blocked: [],
    suggested: [],
    streak: 0,
    globalPatternsCount: 0,
  };

  // 1. Load sessions within the time window
  let windowSessions: SessionIndexEntry[] = [];
  try {
    const allSessions = listSessions();
    windowSessions = allSessions.filter((s) => s.completedAt >= window.since);
  } catch {
    // Non-critical
  }

  // 2. Build session summaries from recording events
  const sessionSummaries: SessionSummary[] = [];
  const allLearnings: string[] = [];

  for (const session of windowSessions) {
    try {
      const events = await readRecordingEvents(session.sessionId);
      const exitEvents = events.filter((e) => e.phase === "exit");
      const lastExitEvent = exitEvents[exitEvents.length - 1];
      const finalState = lastExitEvent?.stateAfter ?? {};

      const taskQueue = (finalState.task_queue ?? []) as Array<Record<string, unknown>>;
      const completedTasks = taskQueue.filter((t) => t.status === "completed");
      const tasksCompleted = completedTasks.length;
      const reworkCount = completedTasks.filter(
        (t) => (t.retry_count as number) > 0,
      ).length;
      const allApproved = reworkCount === 0;

      sessionSummaries.push({
        sessionId: session.sessionId,
        goal: session.goal,
        tasksCompleted,
        reworkCount,
        allApproved,
      });

      // Team learnings
      const promotedThisRun = (finalState.promoted_this_run ?? []) as string[];
      const ancestralLessons = (finalState.ancestral_lessons ?? []) as string[];
      allLearnings.push(...promotedThisRun, ...ancestralLessons);
    } catch {
      // Skip corrupted sessions
      sessionSummaries.push({
        sessionId: session.sessionId,
        goal: session.goal,
        tasksCompleted: 0,
        reworkCount: 0,
        allApproved: true,
      });
    }
  }

  result.yesterday.sessions = sessionSummaries;
  result.yesterday.totalTasks = sessionSummaries.reduce((sum, s) => sum + s.tasksCompleted, 0);
  // Deduplicate learnings
  const seen = new Set<string>();
  for (const l of allLearnings) {
    if (l && !seen.has(l)) {
      seen.add(l);
      result.yesterday.teamLearnings.push(l);
    }
  }

  // 3. Blocked items from most recent session's final state only
  try {
    if (windowSessions.length > 0) {
      const mostRecent = windowSessions[0]!; // already sorted most recent first
      const events = await readRecordingEvents(mostRecent.sessionId);
      const exitEvents = events.filter((e) => e.phase === "exit");
      const lastExitEvent = exitEvents[exitEvents.length - 1];
      const finalState = lastExitEvent?.stateAfter ?? {};

      const blocked: BlockedItem[] = [];

      // Deferred and escalated tasks from next_sprint_backlog
      const nextSprintBacklog = (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>;
      for (const item of nextSprintBacklog) {
        const desc = (item.description as string) ?? (item.task_id as string) ?? "Unknown task";
        const reason = (item.reason as string) ?? "deferred";
        if (reason === "deferred") {
          blocked.push({
            type: "deferred_task",
            description: desc,
            sessionId: mostRecent.sessionId,
            priority: "low",
          });
        } else if (reason === "escalated") {
          blocked.push({
            type: "escalated_task",
            description: desc,
            sessionId: mostRecent.sessionId,
            priority: "high",
          });
        }
      }

      // Open RFC
      const rfcDoc = finalState.rfc_document as string | null;
      if (rfcDoc && rfcDoc.trim()) {
        const firstLine = rfcDoc.trim().split("\n")[0] ?? "RFC draft";
        const title = firstLine.replace(/^#+\s*/, "").trim();
        blocked.push({
          type: "open_rfc",
          description: title,
          sessionId: mostRecent.sessionId,
          priority: "high",
        });
      }

      // Agent alerts from agent profiles
      const agentProfiles = (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>;
      for (const profile of agentProfiles) {
        const role = (profile.agentRole as string) ?? (profile.role as string) ?? "";
        if (!role) continue;

        const scoreHistory = (profile.scoreHistory as number[]) ?? [];
        const overallScore = (profile.overallScore as number) ?? 0;

        let trend: "improving" | "stable" | "degrading" = "stable";
        if (scoreHistory.length >= 2) {
          const recent = scoreHistory[scoreHistory.length - 1]!;
          const previous = scoreHistory[scoreHistory.length - 2]!;
          const delta = recent - previous;
          if (delta > 0.03) trend = "improving";
          else if (delta < -0.03) trend = "degrading";
        }

        const taskTypeScores = (profile.taskTypeScores ?? []) as Array<Record<string, unknown>>;
        const hasDegradingType = taskTypeScores.some((t) => t.trend === "degrading");
        if (hasDegradingType && trend === "stable") trend = "degrading";

        const alert = trend === "degrading" || overallScore < 0.5;
        if (alert) {
          blocked.push({
            type: "agent_alert",
            description: `Agent "${role}" — score ${overallScore.toFixed(2)}, trend ${trend}`,
            sessionId: mostRecent.sessionId,
            priority: "medium",
          });
        }
      }

      result.blocked = blocked;

      // 4. Generate suggestions based on blocked items
      const suggested: SuggestionItem[] = [];
      for (const item of blocked) {
        switch (item.type) {
          case "open_rfc":
            suggested.push({
              type: "execute_rfc",
              description: `Execute RFC: ${item.description}`,
              reasoning: "Open RFC from last session should be resolved before new work begins.",
            });
            break;
          case "escalated_task":
            suggested.push({
              type: "resolve_escalation",
              description: `Resolve escalated task: ${item.description}`,
              reasoning: "Escalated tasks indicate complexity that needs human guidance.",
            });
            break;
          case "deferred_task":
            suggested.push({
              type: "follow_up",
              description: `Follow up on deferred task: ${item.description}`,
              reasoning: "Deferred tasks should be re-prioritized or explicitly dropped.",
            });
            break;
          case "agent_alert":
            suggested.push({
              type: "agent_health",
              description: `Review agent performance: ${item.description}`,
              reasoning: "Degrading or low-scoring agents may need reconfiguration or role reassignment.",
            });
            break;
        }
      }
      result.suggested = suggested;
    }
  } catch {
    // Non-critical — blocked items default to empty
  }

  // 5. Streak from StreakTracker
  try {
    const { StreakTracker } = await import("./streak.js");
    const lancedbMod = await import("@lancedb/lancedb");
    const dbPath = path.join(os.homedir(), ".openpawl", "memory", "global.db");
    const db = await lancedbMod.connect(dbPath);
    const tracker = new StreakTracker();
    await tracker.init(db);
    result.streak = await tracker.getCurrentStreak();
  } catch {
    result.streak = 0;
  }

  // 6. Global patterns count
  try {
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");

    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (embedder) {
      const globalMgr = new GlobalMemoryManager();
      await globalMgr.init(embedder);
      const health = await globalMgr.getHealth();
      result.globalPatternsCount = health.totalGlobalPatterns;
    }
  } catch {
    result.globalPatternsCount = 0;
  }

  return result;
}

/**
 * Returns timestamp for Monday 00:00 local time of the current week.
 */
export function getMondayMidnight(): number {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0, 0);
  return monday.getTime();
}

/**
 * Collect weekly summary for the current Monday-Sunday week.
 */
export async function collectWeeklySummary(): Promise<WeeklySummary> {
  const mondayMs = getMondayMidnight();
  const sundayMs = mondayMs + 7 * 24 * 60 * 60 * 1000;
  const mondayDate = new Date(mondayMs);
  const weekLabel = `${mondayDate.toISOString().slice(0, 10)} week`;

  const summary: WeeklySummary = {
    weekLabel,
    sessionCount: 0,
    activeDays: 0,
    tasksCompleted: 0,
    autoApproved: 0,
    reworkCount: 0,
    avgConfidence: 0,
    prevWeekAvgConfidence: null,
    newGlobalPatterns: 0,
    newSessionPatterns: 0,
    topDomains: [],
    bestDay: null,
    streak: 0,
  };

  let allSessions: SessionIndexEntry[] = [];
  try {
    allSessions = listSessions();
  } catch {
    return summary;
  }

  // Current week sessions
  const weekSessions = allSessions.filter(
    (s) => s.completedAt >= mondayMs && s.completedAt < sundayMs,
  );

  summary.sessionCount = weekSessions.length;

  // Average confidence from session index
  if (weekSessions.length > 0) {
    const totalConf = weekSessions.reduce((sum, s) => sum + s.averageConfidence, 0);
    summary.avgConfidence = totalConf / weekSessions.length;
  }

  // Previous week avg confidence
  try {
    const prevMondayMs = mondayMs - 7 * 24 * 60 * 60 * 1000;
    const prevSundayMs = mondayMs;
    const prevWeekSessions = allSessions.filter(
      (s) => s.completedAt >= prevMondayMs && s.completedAt < prevSundayMs,
    );
    if (prevWeekSessions.length > 0) {
      const prevTotal = prevWeekSessions.reduce((sum, s) => sum + s.averageConfidence, 0);
      summary.prevWeekAvgConfidence = prevTotal / prevWeekSessions.length;
    }
  } catch {
    // Non-critical
  }

  // Per-day tracking for active days, best day, domains
  const dayMap = new Map<string, { taskCount: number; confidenceSum: number; confidenceCount: number }>();
  const domainMap = new Map<string, number>();
  let totalAutoApproved = 0;
  let totalRework = 0;
  let totalTasksCompleted = 0;
  let totalNewGlobalPatterns = 0;
  let totalNewSessionPatterns = 0;

  for (const session of weekSessions) {
    try {
      const events = await readRecordingEvents(session.sessionId);
      const exitEvents = events.filter((e) => e.phase === "exit");
      const lastExitEvent = exitEvents[exitEvents.length - 1];
      const finalState = lastExitEvent?.stateAfter ?? {};

      const taskQueue = (finalState.task_queue ?? []) as Array<Record<string, unknown>>;
      const completedTasks = taskQueue.filter((t) => t.status === "completed");
      const sessionTaskCount = completedTasks.length;
      const sessionRework = completedTasks.filter(
        (t) => (t.retry_count as number) > 0,
      ).length;
      const sessionAutoApproved = sessionTaskCount - sessionRework;

      totalTasksCompleted += sessionTaskCount;
      totalAutoApproved += sessionAutoApproved;
      totalRework += sessionRework;

      // Patterns
      const promotedThisRun = (finalState.promoted_this_run ?? []) as string[];
      totalNewGlobalPatterns += promotedThisRun.length;
      const ancestralLessons = (finalState.ancestral_lessons ?? []) as string[];
      totalNewSessionPatterns += ancestralLessons.length;

      // Day tracking
      const dayLabel = new Date(session.completedAt).toISOString().slice(0, 10);
      const existing = dayMap.get(dayLabel) ?? { taskCount: 0, confidenceSum: 0, confidenceCount: 0 };
      existing.taskCount += sessionTaskCount;
      existing.confidenceSum += session.averageConfidence;
      existing.confidenceCount += 1;
      dayMap.set(dayLabel, existing);

      // Domain tracking — first 2 words of session goal
      const words = session.goal.trim().split(/\s+/).slice(0, 2);
      const domain = words.join(" ").toLowerCase();
      if (domain) {
        domainMap.set(domain, (domainMap.get(domain) ?? 0) + sessionTaskCount);
      }
    } catch {
      // Skip corrupted sessions
    }
  }

  summary.tasksCompleted = totalTasksCompleted;
  summary.autoApproved = totalAutoApproved;
  summary.reworkCount = totalRework;
  summary.newGlobalPatterns = totalNewGlobalPatterns;
  summary.newSessionPatterns = totalNewSessionPatterns;
  summary.activeDays = dayMap.size;

  // Top domains (sorted by task count descending)
  summary.topDomains = Array.from(domainMap.entries())
    .map(([domain, taskCount]) => ({ domain, taskCount }))
    .sort((a, b) => b.taskCount - a.taskCount)
    .slice(0, 5);

  // Best day (highest task count)
  let bestDay: WeeklySummary["bestDay"] = null;
  for (const [dayLabel, data] of dayMap.entries()) {
    const avgConf = data.confidenceCount > 0 ? data.confidenceSum / data.confidenceCount : 0;
    if (!bestDay || data.taskCount > bestDay.taskCount) {
      bestDay = {
        dayLabel,
        taskCount: data.taskCount,
        avgConfidence: avgConf,
      };
    }
  }
  summary.bestDay = bestDay;

  // Streak
  try {
    const { StreakTracker } = await import("./streak.js");
    const lancedbMod = await import("@lancedb/lancedb");
    const dbPath = path.join(os.homedir(), ".openpawl", "memory", "global.db");
    const db = await lancedbMod.connect(dbPath);
    const tracker = new StreakTracker();
    await tracker.init(db);
    summary.streak = await tracker.getCurrentStreak();
  } catch {
    summary.streak = 0;
  }

  return summary;
}
