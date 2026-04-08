/**
 * Audit trail builder — compiles a structured audit from GraphState and recording events.
 */

import type {
  AuditTrail,
  AuditSummary,
  DecisionEntry,
  ApprovalEntry,
  CostEntry,
  MemoryUsageEntry,
  AgentPerformanceEntry,
  PersonalityEventSummary,
} from "./types.js";
import { PersonalityEventStore } from "../personality/memory.js";
import { CONFIG } from "../core/config.js";
import { readRecordingEvents } from "../replay/storage.js";
import type { RecordingEvent } from "../replay/types.js";
import { getRoleName } from "../core/bot-definitions.js";
import type { BotDefinition } from "../core/bot-definitions.js";

// Dollar cost estimation removed — these are kept as zero for type compat
const COST_PER_INPUT_TOKEN = 0;
const COST_PER_OUTPUT_TOKEN = 0;

export async function buildAuditTrail(
  sessionId: string,
  runIndex: number,
  finalState: Record<string, unknown>,
  startedAt: number,
  completedAt: number,
  team: BotDefinition[],
): Promise<AuditTrail> {
  // Load recording events (gracefully handles missing recordings)
  let recordingEvents: RecordingEvent[] = [];
  try {
    recordingEvents = await readRecordingEvents(sessionId);
    if (runIndex > 0) {
      recordingEvents = recordingEvents.filter((e) => e.runIndex === runIndex);
    }
  } catch {
    // Partial audit if recording unavailable
  }

  const taskQueue = (finalState.task_queue ?? []) as Record<string, unknown>[];
  const botStats = (finalState.bot_stats ?? {}) as Record<string, Record<string, unknown>>;
  const approvalStats = (finalState.approval_stats ?? {}) as Record<string, unknown>;
  const routingDecisions = (finalState.routing_decisions ?? []) as Record<string, unknown>[];

  const summary = buildSummary(taskQueue, botStats, approvalStats, recordingEvents, finalState);
  const decisionLog = buildDecisionLog(recordingEvents, taskQueue);
  const approvalHistory = buildApprovalHistory(taskQueue, routingDecisions);
  const costBreakdown = buildCostBreakdown(taskQueue, botStats, recordingEvents, team);
  const memoryUsage = buildMemoryUsage(finalState);
  const agentPerformance = buildAgentPerformance(taskQueue, botStats, team, finalState);

  const teamRoles = team.map((b) => getRoleName(b));

  let personalityEvents: PersonalityEventSummary[] | undefined;
  if (CONFIG.personalityEnabled) {
    try {
      const lancedb = await import("@lancedb/lancedb");
      const os = await import("node:os");
      const path = await import("node:path");
      const dbPath = path.default.join(os.default.homedir(), ".openpawl", "memory", "global.db");
      const db = await lancedb.connect(dbPath);
      const store = new PersonalityEventStore();
      await store.init(db);
      const events = await store.getBySession(sessionId);
      personalityEvents = events.map((e) => ({
        agentRole: e.agentRole,
        eventType: e.eventType,
        content: e.content,
        severity: null,
        timestamp: e.createdAt,
      }));
    } catch {
      // Personality events unavailable
    }
  }

  // Build vibe score for this run (best-effort)
  let vibeScore: import("./types.js").AuditTrail["vibeScore"];
  try {
    const { calculateScore, buildScoreInputFromState, detectPatterns, selectTip } = await import("../score/index.js");
    const scoreInput = buildScoreInputFromState(finalState, [], [], []);
    const scoreResult = calculateScore(scoreInput);
    const patterns = detectPatterns(scoreResult, scoreInput);
    const tip = selectTip(scoreResult, scoreInput);
    vibeScore = {
      overall: scoreResult.overall,
      teamTrust: scoreResult.dimensions.team_trust.score,
      reviewEngagement: scoreResult.dimensions.review_engagement.score,
      warningResponse: scoreResult.dimensions.warning_response.score,
      confidenceAlignment: scoreResult.dimensions.confidence_alignment.score,
      patterns: patterns.map((p) => p.label),
      tip,
    };
  } catch {
    // Score calculation non-critical
  }

  // Build provider stats (best-effort)
  let providerStats: import("./types.js").AuditTrail["providerStats"];
  try {
    const { getProviderManager } = await import("../proxy/ProxyService.js");
    const mgr = getProviderManager();
    if (mgr) {
      const stats = mgr.getStats();
      let total = 0;
      for (const [key, val] of Object.entries(stats)) {
        if (key !== "fallbacksTriggered" && typeof val === "object" && val) {
          total += (val as { requests: number }).requests;
        }
      }
      if (total > 0) {
        providerStats = stats;
      }
    }
  } catch {
    // Provider stats unavailable
  }

  // Build cache performance stats (best-effort)
  let cachePerformance: import("./types.js").AuditTrail["cachePerformance"];
  try {
    const { getSessionCacheStats } = await import("../cache/cache-interceptor.js");
    const cStats = getSessionCacheStats();
    const total = cStats.hits + cStats.misses;
    if (total > 0) {
      cachePerformance = {
        hitRate: cStats.hits / total,
        entriesUsed: cStats.hits,
        costSaved: cStats.savedUSD,
        timeSavedMs: cStats.savedMs,
      };
    }
  } catch {
    // Cache stats unavailable
  }

  return {
    sessionId,
    runIndex,
    goal: (finalState.user_goal as string) ?? "",
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    teamComposition: teamRoles,
    summary,
    decisionLog,
    approvalHistory,
    costBreakdown,
    memoryUsage,
    agentPerformance,
    ...(personalityEvents?.length ? { personalityEvents } : {}),
    ...(vibeScore ? { vibeScore } : {}),
    ...(cachePerformance ? { cachePerformance } : {}),
    ...(providerStats ? { providerStats } : {}),
  };
}

function buildSummary(
  taskQueue: Record<string, unknown>[],
  botStats: Record<string, Record<string, unknown>>,
  approvalStats: Record<string, unknown>,
  events: RecordingEvent[],
  state: Record<string, unknown>,
): AuditSummary {
  const completed = taskQueue.filter((t) => t.status === "completed" || t.status === "waiting_for_human" || t.status === "auto_approved_pending").length;
  const failed = taskQueue.filter((t) => t.status === "failed").length;

  const autoApproved = (approvalStats.autoApprovedCount as number) ?? 0;
  const userApproved = (approvalStats.manualApprovedCount as number) ?? 0;
  const rejected = (approvalStats.rejectedCount as number) ?? 0;
  const escalated = (approvalStats.escalatedCount as number) ?? 0;

  // Sum tokens from recording events
  let totalInput = 0;
  const totalOutput = 0;
  for (const evt of events) {
    if (evt.phase === "exit" && evt.agentOutput) {
      totalInput += evt.agentOutput.tokensUsed ?? 0;
    }
  }

  const avgConfidence = (state.average_confidence as number) ?? 0;

  return {
    tasksCompleted: completed,
    tasksFailed: failed,
    autoApproved,
    userApproved,
    rejected,
    escalated,
    averageConfidence: avgConfidence,
    totalTokensInput: totalInput,
    totalTokensOutput: totalOutput,
    totalCostUSD: totalInput * COST_PER_INPUT_TOKEN + totalOutput * COST_PER_OUTPUT_TOKEN,
  };
}

function buildDecisionLog(events: RecordingEvent[], _taskQueue: Record<string, unknown>[]): DecisionEntry[] {
  const log: DecisionEntry[] = [];

  for (const evt of events) {
    if (evt.phase !== "exit") continue;

    let decision = `${evt.nodeId} completed`;
    const data: Record<string, unknown> = {};

    if (evt.nodeId === "coordinator") {
      const tasks = (evt.stateAfter?.task_queue as Record<string, unknown>[]) ?? [];
      const pending = tasks.filter((t) => t.status === "pending").length;
      decision = `Coordinator decomposed goal into ${pending} tasks`;
      data.pendingTasks = pending;
    } else if (evt.nodeId === "worker_task") {
      const taskId = (evt.stateAfter?.task_queue as Record<string, unknown>[])?.find(
        (t) => t.status === "completed" || t.status === "reviewing"
      )?.task_id;
      decision = taskId ? `Worker completed task ${taskId}` : "Worker processed task";
      if (evt.agentOutput?.confidence) {
        data.confidence = evt.agentOutput.confidence.score;
        data.flags = evt.agentOutput.confidence.flags;
      }
      if (evt.durationMs) data.durationMs = evt.durationMs;
      if (evt.agentOutput?.tokensUsed) data.tokensUsed = evt.agentOutput.tokensUsed;
    } else if (evt.nodeId === "approval") {
      const response = evt.stateAfter?.approval_response as Record<string, unknown> | null;
      decision = response?.action
        ? `Approval: ${response.action}`
        : "Awaiting approval";
      data.action = response?.action;
    } else if (evt.nodeId === "confidence_router") {
      decision = "Confidence router evaluated task results";
    } else if (evt.nodeId === "preview_gate") {
      decision = "Preview shown for user approval";
    } else if (evt.nodeId === "sprint_planning") {
      decision = "Sprint planning completed";
    } else if (evt.nodeId === "system_design") {
      decision = "System design phase completed";
    } else if (evt.nodeId === "rfc_phase") {
      decision = "RFC phase completed";
    } else if (evt.nodeId === "memory_retrieval") {
      decision = "Memory retrieval completed";
    }

    log.push({
      timestamp: evt.timestamp,
      nodeId: evt.nodeId,
      phase: evt.phase,
      decision,
      data,
    });
  }

  return log;
}

function buildApprovalHistory(
  taskQueue: Record<string, unknown>[],
  _routingDecisions: Record<string, unknown>[],
): ApprovalEntry[] {
  const history: ApprovalEntry[] = [];

  for (const task of taskQueue) {
    const taskId = (task.task_id as string) ?? "";
    const status = (task.status as string) ?? "";
    const result = (task.result as Record<string, unknown>) ?? {};
    const confidence = result.confidence as Record<string, unknown> | undefined;
    const routing = (result.routing_decision as string) ?? "";

    if (status === "completed" || status === "waiting_for_human" || status === "auto_approved_pending") {
      const action = routing === "auto_approved" ? "auto-approved" :
                     status === "waiting_for_human" ? "approved" : "completed";
      const by = routing === "auto_approved" ? "system" : "user";

      history.push({
        taskId,
        action,
        by,
        at: Date.now(),
        feedback: (task.reviewer_feedback as string) ?? null,
        confidence: (confidence?.score as number) ?? undefined,
        routingDecision: routing || undefined,
      });
    } else if (status === "failed") {
      history.push({
        taskId,
        action: "failed",
        by: "system",
        at: Date.now(),
        feedback: null,
        confidence: (confidence?.score as number) ?? undefined,
      });
    } else if (status === "needs_rework") {
      history.push({
        taskId,
        action: "rejected",
        by: "user",
        at: Date.now(),
        feedback: (task.reviewer_feedback as string) ?? null,
        confidence: (confidence?.score as number) ?? undefined,
      });
    }
  }

  return history;
}

function buildCostBreakdown(
  taskQueue: Record<string, unknown>[],
  botStats: Record<string, Record<string, unknown>>,
  events: RecordingEvent[],
  team: BotDefinition[],
): CostEntry[] {
  const agentMap = new Map<string, CostEntry>();

  for (const bot of team) {
    const name = getRoleName(bot);
    const stats = botStats[bot.id] ?? {};
    const tasks = ((stats.tasks_completed as number) ?? 0) + ((stats.tasks_failed as number) ?? 0);

    agentMap.set(bot.id, {
      agent: name,
      tasks,
      tokensInput: 0,
      tokensOutput: 0,
      costUSD: 0,
    });
  }

  // Aggregate tokens from events (best effort)
  for (const evt of events) {
    if (evt.phase !== "exit" || !evt.agentOutput) continue;
    // Try to match to a bot — events use nodeId, not botId, so this is approximate
    const tokens = evt.agentOutput.tokensUsed ?? 0;
    for (const entry of agentMap.values()) {
      if (entry.tasks > 0) {
        entry.tokensInput += Math.round(tokens / agentMap.size);
        break;
      }
    }
  }

  // Calculate costs
  for (const entry of agentMap.values()) {
    entry.costUSD = entry.tokensInput * COST_PER_INPUT_TOKEN + entry.tokensOutput * COST_PER_OUTPUT_TOKEN;
  }

  return Array.from(agentMap.values()).filter((e) => e.tasks > 0);
}

function buildMemoryUsage(state: Record<string, unknown>): MemoryUsageEntry {
  const memContext = (state.memory_context ?? {}) as Record<string, unknown>;
  const successPatterns = (memContext.successPatterns as unknown[]) ?? [];
  const failureLessons = (memContext.failureLessons as unknown[]) ?? [];
  const newPatterns = (state.new_success_patterns as string[]) ?? [];
  const promoted = (state.promoted_this_run as string[]) ?? [];

  return {
    successPatternsRetrieved: successPatterns.length,
    failureLessonsRetrieved: failureLessons.length,
    newPatternsStored: newPatterns.length,
    globalPatternsPromoted: promoted.length,
  };
}

function buildAgentPerformance(
  taskQueue: Record<string, unknown>[],
  botStats: Record<string, Record<string, unknown>>,
  team: BotDefinition[],
  state: Record<string, unknown>,
): AgentPerformanceEntry[] {
  const profiles = (state.agent_profiles ?? []) as Record<string, unknown>[];
  const entries: AgentPerformanceEntry[] = [];

  for (const bot of team) {
    const stats = botStats[bot.id] ?? {};
    const completed = (stats.tasks_completed as number) ?? 0;
    const failed = (stats.tasks_failed as number) ?? 0;
    const total = completed + failed;
    if (total === 0) continue;

    // Find matching profile
    const profile = profiles.find((p) => (p.agentRole as string) === bot.role_id);
    const profileScore = profile ? (profile.overallScore as number) ?? null : null;

    // Calculate avg confidence for this bot's tasks
    const botTasks = taskQueue.filter((t) => (t.assigned_to as string) === bot.id);
    let avgConf = 0;
    let confCount = 0;
    for (const task of botTasks) {
      const result = (task.result as Record<string, unknown>) ?? {};
      const conf = result.confidence as Record<string, unknown> | undefined;
      if (conf && typeof conf.score === "number") {
        avgConf += conf.score as number;
        confCount++;
      }
    }
    if (confCount > 0) avgConf /= confCount;

    const vsProfile = profileScore != null ? avgConf - profileScore : null;

    entries.push({
      agent: getRoleName(bot),
      roleId: bot.role_id,
      tasks: total,
      avgConfidence: Math.round(avgConf * 100) / 100,
      vsProfile: vsProfile != null ? Math.round(vsProfile * 100) / 100 : null,
      trend: vsProfile == null ? "stable" : vsProfile > 0.02 ? "up" : vsProfile < -0.02 ? "down" : "stable",
    });
  }

  return entries;
}
