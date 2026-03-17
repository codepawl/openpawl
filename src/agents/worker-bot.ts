/**
 * Worker Bot - Executes tasks via WorkerAdapter.
 * Supports cross-review workflow: Maker -> QA Reviewer -> (rework) -> Maker
 */

import { Send } from "@langchain/langgraph";
import type { GraphState } from "../core/graph-state.js";
import type { BotDefinition } from "../core/bot-definitions.js";
import type { WorkerAdapter, StreamChunkCallback, StreamDoneCallback, TokenUsageCallback, ReasoningCallback } from "../adapters/worker-adapter.js";
import { createRoutingAdapters } from "../adapters/worker-adapter.js";
import type { TaskRequest, TaskResult } from "../core/state.js";
import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { getCanvasTelemetry } from "../core/canvas-telemetry.js";
import { workerEvents } from "../core/worker-events.js";
import {
  formatExecutionError,
  createStandupMessage,
  parseReviewVerdict,
  buildReviewPrompt,
  buildReworkPrompt,
} from "./review-workflow.js";
import { withConfidenceScoring } from "../graph/confidence/prompt.js";
import { extractDecisions } from "../journal/extractor.js";
import type { AgentProfile, RoutingDecision } from "./profiles/types.js";
import { ProfileRouter } from "./profiles/router.js";

const OPENCLAW_UNAVAILABLE_MSG = "OpenClaw required but service unavailable";

/** Module-level accumulator for routing decisions made during task dispatch */
let pendingRoutingDecisions: RoutingDecision[] = [];

/** Flush and return accumulated routing decisions */
export function flushRoutingDecisions(): RoutingDecision[] {
  const decisions = pendingRoutingDecisions;
  pendingRoutingDecisions = [];
  return decisions;
}

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

export type WorkerTier = "light" | "heavy";

export class WorkerBot {
  readonly bot: BotDefinition;
  readonly adapter: WorkerAdapter;
  readonly targetUrl: string;
  private readonly heavyAdapter: WorkerAdapter | null;

  constructor(
    botDefinition: BotDefinition,
    adapterImpl: WorkerAdapter,
    heavyAdapterImpl: WorkerAdapter | null = null
  ) {
    this.bot = botDefinition;
    this.adapter = adapterImpl;
    this.heavyAdapter = heavyAdapterImpl;
    this.targetUrl = typeof (adapterImpl as { workerUrl?: unknown }).workerUrl === "string"
      ? String((adapterImpl as { workerUrl?: string }).workerUrl ?? "").trim()
      : "";
    log(`🤖 WorkerBot '${this.bot.name}' (${this.bot.role_id}) initialized`);
  }

  async executeTask(
    task: {
      task_id: string;
      description: string;
      priority?: string;
      estimated_cost?: number;
    },
    options?: { worker_tier?: WorkerTier; systemPrompt?: string }
  ): Promise<TaskResult> {
    const worker_tier = options?.worker_tier ?? "light";
    const taskId = task.task_id;
    const botId = this.bot.id;
    const telemetry = getCanvasTelemetry();

    type StreamableAdapter = WorkerAdapter & {
      onStreamChunk?: StreamChunkCallback;
      onStreamDone?: StreamDoneCallback;
      onTokenUsage?: TokenUsageCallback;
      onReasoning?: ReasoningCallback;
    };

    const adapterWithStream = this.adapter as StreamableAdapter;
    const heavyAdapterWithStream = this.heavyAdapter as StreamableAdapter | null;

    const setupStreaming = (adapter: StreamableAdapter | null) => {
      if (adapter && typeof adapter.onStreamChunk === "function") {
        adapter.onStreamChunk = (chunk: string) => {
          telemetry.sendStreamChunk(taskId, botId, chunk);
        };
        adapter.onStreamDone = (error?: { message: string }) => {
          telemetry.sendStreamDone(taskId, botId, error);
        };
        adapter.onTokenUsage = (inputTokens: number, outputTokens: number, cachedInputTokens: number, model: string) => {
          telemetry.sendTokenUsage(inputTokens, outputTokens, cachedInputTokens, model);
        };
        adapter.onReasoning = (reasoning: string) => {
          telemetry.sendReasoning(taskId, botId, reasoning);
          workerEvents.emit("reasoning", { taskId, botId, reasoning });
        };
      }
    };

    const clearStreaming = (adapter: StreamableAdapter | null) => {
      if (adapter) {
        adapter.onStreamChunk = undefined;
        adapter.onStreamDone = undefined;
        adapter.onTokenUsage = undefined;
        adapter.onReasoning = undefined;
      }
    };

    setupStreaming(adapterWithStream);
    if (heavyAdapterWithStream) {
      setupStreaming(heavyAdapterWithStream);
    }

    const req: TaskRequest = {
      task_id: task.task_id,
      description: task.description,
      priority: task.priority ?? "MEDIUM",
      estimated_cost: task.estimated_cost ?? 0,
    };

    try {
      if (worker_tier === "heavy" && this.heavyAdapter) {
        const healthy = await this.heavyAdapter.healthCheck();
        if (!healthy) {
          log(`Heavy task ${task.task_id} failed: OpenClaw unavailable`);
          telemetry.sendStreamDone(taskId, botId, { message: "OpenClaw unavailable" });
          clearStreaming(adapterWithStream);
          if (heavyAdapterWithStream) {
            clearStreaming(heavyAdapterWithStream);
          }
          return {
            task_id: task.task_id,
            success: false,
            output: OPENCLAW_UNAVAILABLE_MSG,
            quality_score: 0,
          };
        }
        const result = await this.heavyAdapter.executeTask(req);
        clearStreaming(adapterWithStream);
        clearStreaming(heavyAdapterWithStream);
        return result;
      }

      const result = await this.adapter.executeTask(req);
      clearStreaming(adapterWithStream);
      if (heavyAdapterWithStream) {
        clearStreaming(heavyAdapterWithStream);
      }
      return result;
    } catch (err) {
      clearStreaming(adapterWithStream);
      if (heavyAdapterWithStream) {
        clearStreaming(heavyAdapterWithStream);
      }
      throw err;
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.adapter.healthCheck();
  }
}

export function createWorkerBots(
  team: BotDefinition[],
  workerUrls: Record<string, string> = {},
  workspacePath?: string
): Record<string, WorkerBot> {
  const bots: Record<string, WorkerBot> = {};
  for (const bot of team) {
    const { light, heavy } = createRoutingAdapters(bot, workerUrls, workspacePath);
    bots[bot.id] = new WorkerBot(bot, light, heavy);
  }
  return bots;
}

/**
 * createTaskDispatcher — conditional edge function that returns Send[] for parallel fan-out.
 * When no actionable tasks exist, returns "worker_collect" to skip to fan-in.
 */
export function createTaskDispatcher(
  workerBots: Record<string, WorkerBot>,
  team?: BotDefinition[],
  profiles?: AgentProfile[],
): (state: GraphState) => Send[] | string {
  const makerBot = team ? team.find((b) => b.role_id === "software_engineer") : null;
  const reviewerBot = team ? team.find((b) => b.role_id === "qa_reviewer") : null;
  const router = profiles && profiles.length > 0 && team
    ? new ProfileRouter(profiles, team)
    : null;

  return (state: GraphState): Send[] | string => {
    const taskQueue = state.task_queue ?? [];

    // Terminal task IDs = completed, failed, or waiting_for_human
    const terminalIds = new Set<string>();
    for (const t of taskQueue) {
      const status = t.status as string;
      if (status === "completed" || status === "failed" || status === "waiting_for_human" || status === "auto_approved_pending" || status === "escalated") {
        terminalIds.add(t.task_id as string);
      }
    }

    // A task is "ready" if (pending OR needs_rework) AND all deps are terminal
    const ready = taskQueue.filter((t) => {
      const status = t.status as string;
      if (status !== "pending" && status !== "needs_rework") return false;
      const deps = (t.dependencies as string[]) ?? [];
      return deps.every((depId) => terminalIds.has(depId));
    });

    const reviewing = taskQueue.filter((t) => t.status === "reviewing");

    if (ready.length === 0 && reviewing.length === 0) {
      return "worker_collect";
    }

    const sends: Send[] = [];

    for (const taskItem of ready) {
      let targetBotId: string;
      if (makerBot) {
        targetBotId = makerBot.id;
      } else {
        targetBotId = (taskItem.assigned_to as string) ?? "";
      }
      const worker = workerBots[targetBotId];
      if (!worker) {
        targetBotId = (taskItem.assigned_to as string) ?? "";
      }

      // Profile-based routing override
      if (router && team) {
        const decision = router.route({
          taskId: (taskItem.task_id as string) ?? "",
          description: (taskItem.description as string) ?? "",
          assignedTo: targetBotId,
        });
        pendingRoutingDecisions.push(decision);
        if (decision.reason === "profile_suggests_reroute") {
          const reroutedBot = team.find((b) => b.role_id === decision.assignedAgent);
          if (reroutedBot && workerBots[reroutedBot.id]) {
            log(`📊 Profile routing: ${taskItem.task_id} → ${decision.assignedAgent} (was ${targetBotId})`);
            targetBotId = reroutedBot.id;
          }
        }
      }

      sends.push(new Send("worker_task", { _send_task: taskItem, _send_bot_id: targetBotId }));
    }

    for (const taskItem of reviewing) {
      let targetBotId: string;
      if (reviewerBot) {
        targetBotId = reviewerBot.id;
      } else {
        targetBotId = (taskItem.assigned_to as string) ?? "";
      }
      sends.push(new Send("worker_task", { _send_task: taskItem, _send_bot_id: targetBotId }));
    }

    return sends;
  };
}

/**
 * createWorkerTaskNode — processes exactly one task. Reads _send_task and _send_bot_id.
 * Never throws — all errors are caught and returned as failed task state.
 */
export function createWorkerTaskNode(
  workerBots: Record<string, WorkerBot>,
  team?: BotDefinition[]
): (state: GraphState) => Promise<Partial<GraphState>> {
  const hasReviewer = team ? team.some((b) => b.role_id === "qa_reviewer") : false;
  const makerBot = team ? team.find((b) => b.role_id === "software_engineer") : null;
  const reviewerBot = team ? team.find((b) => b.role_id === "qa_reviewer") : null;

  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const taskItem = state._send_task;
    const botId = state._send_bot_id ?? "";

    if (!taskItem) {
      return { __node__: "worker_task" };
    }

    const taskId = (taskItem.task_id as string) ?? "?";
    const currentStatus = (taskItem.status as string) ?? "pending";
    const description = (taskItem.description as string) ?? "";
    const reviewerFeedback = (taskItem.reviewer_feedback as string) ?? null;
    const retryCount = (taskItem.retry_count as number) ?? 0;
    const maxRetries = (taskItem.max_retries as number) ?? 2;
    const taskQueue = state.task_queue ?? [];

    try {
      // Resolve worker
      let assignedTo = botId;
      let worker = workerBots[assignedTo];

      if (!worker) {
        assignedTo = (taskItem.assigned_to as string) ?? "";
        worker = workerBots[assignedTo];
      }

      if (!worker) {
        const updatedTask = {
          ...taskItem,
          status: "failed",
          assigned_to: assignedTo,
          result: { task_id: taskId, success: false, output: "Worker not found", quality_score: 0 },
        };
        return {
          task_queue: [updatedTask],
          messages: [`❌ [${assignedTo}] error: ${taskId} - Worker not found`],
          __node__: "worker_task",
        };
      }

      // Health check
      const healthy = await worker.healthCheck();
      if (!healthy) {
        const updatedTask = {
          ...taskItem,
          status: "failed",
          assigned_to: assignedTo,
          result: { task_id: taskId, success: false, output: "Worker unreachable (health check failed)", quality_score: 0 },
        };
        return {
          task_queue: [updatedTask],
          bot_stats: { [assignedTo]: { tasks_failed: 1 } },
          messages: [`❌ [${worker.bot.name}] error: ${taskId} - Worker unreachable`],
          __node__: "worker_task",
        };
      }

      const uiMessages: string[] = [];
      const standupMessages: Record<string, unknown>[] = [];

      // Build task description based on status
      let taskDescription = description;
      const isMainExecution = currentStatus === "pending" || currentStatus === "needs_rework";

      if (isMainExecution) {
        const standup = createStandupMessage(taskItem, worker.bot.name, assignedTo, taskQueue);
        uiMessages.push(standup.content.replace(/\n/g, " | "));
        standupMessages.push(standup);
      }

      if (currentStatus === "needs_rework" && reviewerFeedback) {
        const rework = buildReworkPrompt(description, reviewerFeedback, retryCount, maxRetries);
        taskDescription = rework.description;
        uiMessages.push(`🔧 [${worker.bot.name}] reworking ${taskId} (${rework.uiLabel})`);
      } else if (currentStatus === "reviewing") {
        const existingResult = taskItem.result as Record<string, unknown> | null;
        const makerOutput = existingResult?.output ? String(existingResult.output) : "No output";
        taskDescription = buildReviewPrompt(description, makerOutput);
        uiMessages.push(`👀 [${worker.bot.name}] reviewing ${taskId}...`);
      } else {
        uiMessages.push(`▶ [${worker.bot.name}] started ${taskId}`);
      }

      // Broadcast in_progress
      workerEvents.emit("progress", {
        taskQueue: taskQueue.map((t) =>
          (t.task_id as string) === taskId
            ? { ...t, status: "in_progress", in_progress_at: new Date().toISOString() }
            : t
        ),
      });

      // Wrap with confidence scoring instructions when enabled
      if (CONFIG.confidenceScoringEnabled) {
        taskDescription = withConfidenceScoring(taskDescription);
      }

      // Execute
      const worker_tier = (taskItem.worker_tier as WorkerTier) ?? "light";
      const result = await worker.executeTask(
        {
          task_id: taskId,
          description: taskDescription,
          priority: (taskItem.priority as string) ?? "MEDIUM",
          estimated_cost: 0,
        },
        { worker_tier },
      );

      // Determine new status
      let reviewVerdict: { approved: boolean; feedback: string } | undefined;
      if (currentStatus === "reviewing") {
        reviewVerdict = parseReviewVerdict(result.output);
      }

      let newStatus: string;
      let newAssignedTo = assignedTo;
      let newFeedback: string | null = null;
      let newRetryCount = retryCount;
      const deltaStats: Record<string, Record<string, number>> = {};

      if (currentStatus === "reviewing" && reviewVerdict) {
        if (reviewVerdict.approved) {
          newStatus = "waiting_for_human";
          uiMessages.push(`\u0007✅ [${worker.bot.name}] approved ${taskId} - awaiting human final approval`);
        } else {
          newRetryCount = retryCount + 1;
          if (newRetryCount > maxRetries) {
            newStatus = "failed";
            uiMessages.push(`❌ [${worker.bot.name}] failed: ${taskId}`);
            deltaStats[assignedTo] = { tasks_failed: 1 };
          } else {
            newStatus = "needs_rework";
            newAssignedTo = makerBot?.id ?? assignedTo;
            newFeedback = reviewVerdict.feedback;
            uiMessages.push(`🔄 [${worker.bot.name}] rework: ${taskId}`);
          }
          // Track reworks_triggered on the reviewer
          for (const bot of Object.values(workerBots)) {
            if (bot.bot.role_id === "qa_reviewer") {
              deltaStats[bot.bot.id] = { ...(deltaStats[bot.bot.id] ?? {}), reworks_triggered: 1 };
              break;
            }
          }
        }
      } else if (currentStatus === "needs_rework") {
        newStatus = "reviewing";
        newAssignedTo = reviewerBot?.id ?? assignedTo;
        uiMessages.push(`📝 [${worker.bot.name}] rework done: ${taskId}`);
      } else if (result.success) {
        if (hasReviewer && reviewerBot) {
          newStatus = "reviewing";
          newAssignedTo = reviewerBot.id;
          uiMessages.push(`✅ [${worker.bot.name}] done: ${taskId} → review`);
        } else {
          newStatus = "completed";
          uiMessages.push(`✅ [${worker.bot.name}] completed: ${taskId}`);
          deltaStats[assignedTo] = { tasks_completed: 1 };
        }
      } else {
        newStatus = "failed";
        uiMessages.push(`❌ [${worker.bot.name}] error: ${taskId}`);
        deltaStats[assignedTo] = { tasks_failed: 1 };
      }

      const updatedTask: Record<string, unknown> = {
        ...taskItem,
        status: newStatus,
        assigned_to: newAssignedTo,
        retry_count: newRetryCount,
        reviewer_feedback: newFeedback,
        result: {
          task_id: taskId,
          success: result.success,
          output: result.output,
          quality_score: result.quality_score,
        },
      };
      if (newStatus === "reviewing" && currentStatus !== "reviewing" && !taskItem.original_maker) {
        updatedTask.original_maker = assignedTo;
      }

      // Build completion agent message
      const ts = new Date().toTimeString().slice(0, 8);
      const summary = result.output.slice(0, 120).replace(/\n/g, " ");
      const action = currentStatus === "reviewing" ? "reviewed" : "completed";
      const completionMsg = {
        from_bot: assignedTo,
        to_bot: "all",
        content: `Task ${taskId} ${action}: ${summary}${result.output.length > 120 ? "..." : ""}`,
        timestamp: ts,
      };

      return {
        task_queue: [updatedTask],
        bot_stats: deltaStats,
        messages: uiMessages,
        agent_messages: [...standupMessages, completionMsg],
        __node__: "worker_task",
      };
    } catch (err) {
      const detail = formatExecutionError(err);
      const updatedTask = {
        ...taskItem,
        status: "failed",
        result: { task_id: taskId, success: false, output: detail, quality_score: 0 },
      };
      return {
        task_queue: [updatedTask],
        messages: [`❌ Task ${taskId} failed: ${detail}`],
        __node__: "worker_task",
      };
    }
  };
}

/**
 * createWorkerCollectNode — post-fan-in node. Computes aggregates from merged state.
 */
export function createWorkerCollectNode(): (state: GraphState) => Partial<GraphState> {
  return (state: GraphState): Partial<GraphState> => {
    const taskQueue = state.task_queue ?? [];

    // Compute average quality from tasks that have results
    const tasksWithQuality = taskQueue.filter((t) => {
      const result = t.result as Record<string, unknown> | null;
      return result && typeof result.quality_score === "number";
    });
    const avgQuality =
      tasksWithQuality.length > 0
        ? Math.round(
            (tasksWithQuality.reduce((sum, t) => {
              const result = t.result as Record<string, unknown>;
              return sum + (Number.isFinite(result.quality_score as number) ? (result.quality_score as number) : 0);
            }, 0) / tasksWithQuality.length) * 100,
          )
        : 0;

    // Compute average confidence from tasks with confidence scores
    const tasksWithConfidence = taskQueue.filter((t) => {
      const r = t.result as Record<string, unknown> | null;
      if (!r) return false;
      const conf = r.confidence as Record<string, unknown> | undefined;
      return conf && typeof conf.score === "number";
    });
    const averageConfidence =
      tasksWithConfidence.length > 0
        ? tasksWithConfidence.reduce((sum, t) => {
            const r = t.result as Record<string, unknown>;
            const conf = r.confidence as Record<string, unknown>;
            return sum + (conf.score as number);
          }, 0) / tasksWithConfidence.length
        : 0;

    const lowConfidenceTasks = taskQueue
      .filter((t) => {
        const r = t.result as Record<string, unknown> | null;
        return r?.routing_decision === "escalated";
      })
      .map((t) => t.task_id as string);

    // Fire-and-forget: extract decisions from agent outputs (async, never blocks)
    try {
      const sessionId = (state as Record<string, unknown>).replaySessionId as string ?? "";
      const goal = (state.user_goal ?? "") as string;
      const runIndex = (state.generation_id ?? 1) as number;
      for (const task of taskQueue) {
        const result = task.result as Record<string, unknown> | null;
        if (!result?.output) continue;
        const agentRole = (task.assigned_to as string) ?? "";
        const output = String(result.output);
        const confObj = result.confidence as Record<string, unknown> | undefined;
        const conf = typeof confObj?.score === "number" ? (confObj.score as number) : 0;
        const decisions = extractDecisions({
          agentRole,
          agentOutput: output,
          taskId: (task.task_id as string) ?? "",
          sessionId,
          runIndex,
          goalContext: goal,
          confidence: conf,
        });
        if (decisions.length > 0) {
          // Async persist — import dynamically to avoid blocking
          void (async () => {
            try {
              const lancedbMod = await import("@lancedb/lancedb");
              const os = await import("node:os");
              const path = await import("node:path");
              const { DecisionStore } = await import("../journal/store.js");
              const { checkSupersession } = await import("../journal/supersession.js");
              const dbPath = path.join(os.homedir(), ".teamclaw", "memory", "global.db");
              const db = await lancedbMod.connect(dbPath);
              const store = new DecisionStore();
              await store.init(db);
              for (const dec of decisions) {
                await store.upsert(dec);
                await checkSupersession(dec, store);
              }
            } catch {
              // Non-critical — decision persistence failure must never affect run
            }
          })();
        }
      }
    } catch {
      // Decision extraction must never block the aggregator
    }

    // Emit final progress with the full merged queue
    workerEvents.emit("progress", { taskQueue: [...taskQueue] });

    const actionableTasks = taskQueue.filter(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "reviewing" ||
             t.status === "needs_rework" || t.status === "waiting_for_human" || t.status === "auto_approved_pending"
    );

    // Flush accumulated routing decisions into state
    const routingDecisions = flushRoutingDecisions();

    return {
      last_action: `Dispatched ${actionableTasks.length} task(s) via parallel Send`,
      last_quality_score: avgQuality,
      deep_work_mode: true,
      parallelism_depth: (state.parallelism_depth ?? 0) + 1,
      average_confidence: averageConfidence,
      low_confidence_tasks: lowConfidenceTasks,
      routing_decisions: routingDecisions.length > 0
        ? routingDecisions.map((d) => ({ ...d }) as Record<string, unknown>)
        : [],
      __node__: "worker_collect",
    };
  };
}

// Keep backward-compatible export for external callers
export { createTaskDispatcher as createWorkerExecuteNode };

