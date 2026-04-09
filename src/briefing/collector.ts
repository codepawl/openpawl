/**
 * Briefing data collector — gathers data from session index, recordings,
 * global memory, and agent profiles for the session briefing.
 *
 * No LLM calls. All data comes from local storage.
 */

import path from "node:path";
import type { BriefingData, LeftOpenItem, TeamPerformanceEntry, RelevantDecision } from "./types.js";
import { summarizeTasks } from "./summarizer.js";
import { listSessions } from "../replay/session-index.js";
import { readRecordingEvents } from "../replay/storage.js";
import type { RecordingEvent } from "../replay/types.js";

/**
 * Collect briefing data from all available sources.
 * Returns BriefingData with whatever data is available — never throws.
 */
export async function collectBriefingData(): Promise<BriefingData> {
  const empty: BriefingData = {
    lastSession: null,
    whatWasBuilt: [],
    teamLearnings: [],
    leftOpen: [],
    teamPerformance: [],
    newGlobalPatterns: 0,
    openRFCs: [],
    relevantDecisions: [],
  };

  // 1. Find last completed session
  const sessions = listSessions(5);
  const lastCompleted = sessions.find((s) => s.completedAt > 0);
  if (!lastCompleted) return empty;

  // Check for CONTEXT.md in cwd
  let contextFileFound = false;
  try {
    const { existsSync, statSync } = await import("node:fs");
    const contextPath = path.resolve("CONTEXT.md");
    if (existsSync(contextPath)) {
      const stat = statSync(contextPath);
      if (stat.mtimeMs > lastCompleted.completedAt) {
        contextFileFound = true;
      }
    }
  } catch {
    // Non-critical
  }

  const now = Date.now();
  const daysAgo = Math.floor((now - lastCompleted.completedAt) / (1000 * 60 * 60 * 24));

  // 2. Read recording events for the last session
  let events: RecordingEvent[] = [];
  try {
    events = await readRecordingEvents(lastCompleted.sessionId);
  } catch {
    // Recording may be corrupted or missing
  }

  // 3. Extract completed tasks from final state
  const exitEvents = events.filter((e) => e.phase === "exit");
  const lastExitEvent = exitEvents[exitEvents.length - 1];
  const finalState = lastExitEvent?.stateAfter ?? {};

  const taskQueue = (finalState.task_queue ?? []) as Array<Record<string, unknown>>;
  const completedTasks = taskQueue.filter((t) => t.status === "completed");
  const failedTasks = taskQueue.filter((t) => t.status === "failed");
  const completedDescriptions = completedTasks
    .map((t) => (t.description as string) ?? "")
    .filter(Boolean);

  // 4. Summarize what was built
  const whatWasBuilt = summarizeTasks(completedDescriptions, 5);

  // 5. Extract team learnings from ancestral_lessons or promoted patterns
  const ancestralLessons = (finalState.ancestral_lessons ?? []) as string[];
  const promotedThisRun = (finalState.promoted_this_run ?? []) as string[];
  const teamLearnings = [
    ...promotedThisRun.slice(0, 2),
    ...ancestralLessons.slice(0, 3 - Math.min(promotedThisRun.length, 2)),
  ].slice(0, 3);

  // 6. Extract left-open items
  const leftOpen: LeftOpenItem[] = [];
  const nextSprintBacklog = (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>;
  for (const item of nextSprintBacklog.slice(0, 3)) {
    const desc = (item.description as string) ?? (item.task_id as string) ?? "Unknown task";
    const reason = (item.reason as string) ?? "deferred";
    leftOpen.push({
      taskDescription: desc,
      reason: reason === "escalated" ? "escalated" : reason === "failed" ? "failed" : "deferred",
      sessionId: lastCompleted.sessionId,
    });
  }

  // Add failed tasks if we have room
  if (leftOpen.length < 3) {
    for (const task of failedTasks.slice(0, 3 - leftOpen.length)) {
      leftOpen.push({
        taskDescription: (task.description as string) ?? (task.task_id as string) ?? "Unknown task",
        reason: "failed",
        sessionId: lastCompleted.sessionId,
      });
    }
  }

  // 7. Extract team performance from agent profiles in final state
  const teamPerformance: TeamPerformanceEntry[] = [];
  const agentProfiles = (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>;
  for (const profile of agentProfiles) {
    const role = (profile.agentRole as string) ?? (profile.role as string) ?? "";
    if (!role) continue;

    const scoreHistory = (profile.scoreHistory as number[]) ?? [];
    const overallScore = (profile.overallScore as number) ?? 0;

    // Determine trend from score history
    let trend: "improving" | "stable" | "degrading" = "stable";
    let confidenceDelta = 0;
    if (scoreHistory.length >= 2) {
      const recent = scoreHistory[scoreHistory.length - 1]!;
      const previous = scoreHistory[scoreHistory.length - 2]!;
      confidenceDelta = recent - previous;
      if (confidenceDelta > 0.03) trend = "improving";
      else if (confidenceDelta < -0.03) trend = "degrading";
    }

    // Check taskTypeScores for trends
    const taskTypeScores = (profile.taskTypeScores ?? []) as Array<Record<string, unknown>>;
    const hasDegradingType = taskTypeScores.some((t) => t.trend === "degrading");
    if (hasDegradingType && trend === "stable") trend = "degrading";

    const alert = trend === "degrading" || overallScore < 0.5;

    teamPerformance.push({ agentRole: role, trend, confidenceDelta, alert });
  }

  // 8. Count new global patterns
  const newGlobalPatterns = promotedThisRun.length;

  // 9. Check for open RFCs
  const openRFCs: string[] = [];
  const rfcDoc = finalState.rfc_document as string | null;
  if (rfcDoc && rfcDoc.trim()) {
    // Extract title from RFC (first heading or first line)
    const firstLine = rfcDoc.trim().split("\n")[0] ?? "RFC draft";
    const title = firstLine.replace(/^#+\s*/, "").trim();
    openRFCs.push(title);
  }

  // 10. Retrieve relevant past decisions (max 2)
  const relevantDecisions: RelevantDecision[] = [];
  try {
    const { DecisionStore } = await import("../journal/store.js");
    const { GlobalMemoryManager } = await import("../memory/global/store.js");
    const { VectorMemory } = await import("../core/knowledge-base.js");
    const { CONFIG } = await import("../core/config.js");

    const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
    await vm.init();
    const embedder = vm.getEmbedder();
    if (embedder) {
      const globalMgr = new GlobalMemoryManager();
      await globalMgr.init(embedder);
      const db = globalMgr.getDb();
      if (db) {
        const decStore = new DecisionStore();
        await decStore.init(db);
        const recent = await decStore.getRecentDecisions(30);
        const active = recent.filter((d) => d.status === "active");
        for (const d of active.slice(0, 2)) {
          relevantDecisions.push({
            decision: d.decision,
            recommendedBy: d.recommendedBy,
            date: new Date(d.capturedAt).toLocaleDateString("en-US", { day: "numeric", month: "short" }),
          });
        }
      }
    }
  } catch {
    // Decision retrieval is non-critical
  }

  // 11. Load recent think sessions (best-effort)
  let recentThinkSessions: BriefingData["recentThinkSessions"];
  try {
    const { VectorMemory: VM } = await import("../core/knowledge-base.js");
    const { CONFIG: CFG } = await import("../core/config.js");
    const vm2 = new VM(CFG.vectorStorePath, CFG.memoryBackend);
    await vm2.init();
    const emb = vm2.getEmbedder();
    if (emb) {
      const { GlobalMemoryManager: GMM } = await import("../memory/global/store.js");
      const gm2 = new GMM();
      await gm2.init(emb);
      const db2 = gm2.getDb();
      if (db2) {
        const { ThinkHistoryStore } = await import("../think/history.js");
        const thinkStore = new ThinkHistoryStore();
        await thinkStore.init(db2);
        const entries = await thinkStore.getAll();
        const recent = entries.slice(0, 3);
        if (recent.length > 0) {
          recentThinkSessions = recent.map((e) => ({
            question: e.question,
            recommendation: e.recommendation,
            savedToJournal: e.savedToJournal,
            date: new Date(e.createdAt).toISOString().slice(0, 10),
          }));
        }
      }
    }
  } catch {
    // Best-effort — don't break briefing if think history fails
  }

  // 12. Load completed async think jobs not yet briefed (best-effort)
  let asyncThinkResults: BriefingData["asyncThinkResults"];
  try {
    const { AsyncThinkJobStore } = await import("../think/job-store.js");
    const jobStore = new AsyncThinkJobStore();
    const unbriefed = jobStore.getUnbriefed();
    if (unbriefed.length > 0) {
      asyncThinkResults = unbriefed.slice(0, 2).map((job) => ({
        jobId: job.id,
        question: job.question,
        recommendation: job.result?.recommendation?.choice ?? "Inconclusive",
        confidence: job.result?.recommendation?.confidence ?? 0,
        completedAt: job.completedAt ?? 0,
        savedToJournal: job.result?.savedToJournal ?? false,
      }));
      for (const job of unbriefed.slice(0, 2)) {
        jobStore.markBriefed(job.id);
      }
    }
  } catch {
    // Best-effort
  }

  // 13. Load latest vibe score (best-effort)
  let vibeScore: BriefingData["vibeScore"];
  try {
    const { VectorMemory: VM3 } = await import("../core/knowledge-base.js");
    const { CONFIG: CFG3 } = await import("../core/config.js");
    const vm3 = new VM3(CFG3.vectorStorePath, CFG3.memoryBackend);
    await vm3.init();
    const emb3 = vm3.getEmbedder();
    if (emb3) {
      const { GlobalMemoryManager: GMM3 } = await import("../memory/global/store.js");
      const gm3 = new GMM3();
      await gm3.init(emb3);
      const db3 = gm3.getDb();
      if (db3) {
        const { VibeScoreStore } = await import("../score/store.js");
        const { calculateTrend } = await import("../score/trends.js");
        const scoreStore = new VibeScoreStore();
        await scoreStore.init(db3);
        const recent = await scoreStore.getRecent(28);
        if (recent.length > 0) {
          const trend = calculateTrend(recent);
          vibeScore = {
            overall: trend.current,
            delta: trend.delta,
            direction: trend.direction,
          };
        }
      }
    }
  } catch {
    // Best-effort — don't break briefing if score fails
  }

  // 14. Standup summary (best-effort)
  let standupSummary: BriefingData["standupSummary"];
  try {
    const { collectStandupData } = await import("../standup/collector.js");
    const { generateSuggestions } = await import("../standup/suggester.js");
    const standupData = await collectStandupData({ since: Date.now() - 24 * 60 * 60 * 1000, label: "24h" });
    standupData.suggested = generateSuggestions(standupData.blocked, standupData.yesterday.sessions);
    standupSummary = {
      sessionCount: standupData.yesterday.sessions.length,
      topBlocked: standupData.blocked[0]?.description ?? null,
      topSuggestion: standupData.suggested[0]?.description ?? null,
    };
  } catch {
    // Best-effort
  }

  // 15. Cache stats (best-effort)
  let cacheStats: BriefingData["cacheStats"];
  try {
    const { ResponseCacheStore } = await import("../cache/cache-store.js");
    const cacheStore = new ResponseCacheStore();
    if (cacheStore.exists()) {
      const stats = await cacheStore.stats();
      if (stats.totalEntries > 0) {
        cacheStats = {
          hitRate: stats.hitRate,
        };
      }
    }
  } catch {
    // Best-effort
  }

  return {
    lastSession: {
      sessionId: lastCompleted.sessionId,
      goal: lastCompleted.goal,
      completedAt: lastCompleted.completedAt,
      daysAgo,
      tasksCompleted: completedTasks.length,
    },
    whatWasBuilt,
    teamLearnings,
    leftOpen: leftOpen.slice(0, 3),
    teamPerformance,
    newGlobalPatterns,
    openRFCs,
    relevantDecisions,
    recentThinkSessions,
    asyncThinkResults,
    contextFileFound,
    vibeScore,
    standupSummary,
    cacheStats,
  };
}
