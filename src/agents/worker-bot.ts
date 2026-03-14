/**
 * Worker Bot - Executes tasks via WorkerAdapter.
 * Supports cross-review workflow: Maker -> QA Reviewer -> (rework) -> Maker
 */

import type { GraphState } from "../core/graph-state.js";
import type { BotDefinition } from "../core/bot-definitions.js";
import type { WorkerAdapter, StreamChunkCallback, StreamDoneCallback, TokenUsageCallback, ReasoningCallback } from "../adapters/worker-adapter.js";
import { createRoutingAdapters } from "../adapters/worker-adapter.js";
import type { TaskRequest, TaskResult } from "../core/state.js";
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

const OPENCLAW_UNAVAILABLE_MSG = "OpenClaw required but service unavailable";

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

export function createWorkerExecuteNode(
  workerBots: Record<string, WorkerBot>,
  team?: BotDefinition[]
): (state: GraphState) => Promise<Partial<GraphState>> {
  const hasReviewer = team ? team.some((b) => b.role_id === "qa_reviewer") : false;
  const makerBot = team ? team.find((b) => b.role_id === "software_engineer") : null;
  const reviewerBot = team ? team.find((b) => b.role_id === "qa_reviewer") : null;

  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const taskQueue = [...(state.task_queue ?? [])];
    const botStats = { ...(state.bot_stats ?? {}) };
    const pulseIntervalMs = (state.pulse_interval_ms as number) ?? 30_000;
    const lastPulseTs = (state.last_pulse_timestamp as number) ?? 0;

    const pending = taskQueue.filter((t) => t.status === "pending" || t.status === "needs_rework");
    const reviewing = taskQueue.filter((t) => t.status === "reviewing");

    if (pending.length === 0 && reviewing.length === 0) {
      return { last_action: "No pending tasks", __node__: "worker_execute", deep_work_mode: false };
    }

    const uiMessages: string[] = [];
    const standupMessages: Array<{ from_bot: string; to_bot: string; content: string; timestamp: string; type: string }> = [];
    const startTime = Date.now();
    let lastPulseTime = lastPulseTs || startTime;

    const checkPulse = (botName: string): void => {
      const now = Date.now();
      if (now - lastPulseTime >= pulseIntervalMs) {
        const elapsed = Math.round((now - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        uiMessages.push(`💓 [Deep Work] ${botName} still working... (${mins}m ${secs}s)`);
        lastPulseTime = now;
      }
    };

    type ExecutionRecord = {
      taskId: string;
      previousStatus: string;
      assignedTo: string;
      workerName: string;
      success: boolean;
      output: string;
      qualityScore: number;
      reviewVerdict?: { approved: boolean; feedback: string };
    };

    const groups = new Map<string, Array<Record<string, unknown>>>();
    const records: ExecutionRecord[] = [];

    const collectTasks = (taskItems: Record<string, unknown>[], targetBotId: string): void => {
      for (const taskItem of taskItems) {
        const taskId = (taskItem.task_id as string) ?? "?";
        const assignedTo = (taskItem.assigned_to as string) ?? targetBotId;
        const worker = workerBots[assignedTo] ?? workerBots[targetBotId];
        if (!worker) {
          records.push({
            taskId,
            previousStatus: taskItem.status as string,
            assignedTo,
            workerName: assignedTo,
            success: false,
            output: "Worker not found",
            qualityScore: 0,
          });
          continue;
        }
        const key = worker.targetUrl || "__shared_default__";
        const bucket = groups.get(key) ?? [];
        bucket.push(taskItem);
        groups.set(key, bucket);
      }
    };

    if (pending.length > 0) {
      const targetBotId = makerBot?.id ?? "";
      if (targetBotId) {
        collectTasks(pending, targetBotId);
      } else {
        for (const taskItem of pending) {
          const taskId = (taskItem.task_id as string) ?? "?";
          const assignedTo = (taskItem.assigned_to as string) ?? "";
          const worker = workerBots[assignedTo];
          if (!worker) {
            records.push({
              taskId,
              previousStatus: taskItem.status as string,
              assignedTo,
              workerName: assignedTo,
              success: false,
              output: "Worker not found",
              qualityScore: 0,
            });
            continue;
          }
          const key = worker.targetUrl || "__shared_default__";
          const bucket = groups.get(key) ?? [];
          bucket.push(taskItem);
          groups.set(key, bucket);
        }
      }
    }
    if (reviewing.length > 0) {
      const targetBotId = reviewerBot?.id ?? "";
      if (targetBotId) {
        collectTasks(reviewing, targetBotId);
      } else {
        for (const taskItem of reviewing) {
          const taskId = (taskItem.task_id as string) ?? "?";
          const assignedTo = (taskItem.assigned_to as string) ?? "";
          const worker = workerBots[assignedTo];
          if (!worker) {
            records.push({
              taskId,
              previousStatus: taskItem.status as string,
              assignedTo,
              workerName: assignedTo,
              success: false,
              output: "Worker not found",
              qualityScore: 0,
            });
            continue;
          }
          const key = worker.targetUrl || "__shared_default__";
          const bucket = groups.get(key) ?? [];
          bucket.push(taskItem);
          groups.set(key, bucket);
        }
      }
    }

    const processGroup = async (items: Array<Record<string, unknown>>): Promise<ExecutionRecord[]> => {
      const out: ExecutionRecord[] = [];
      for (const taskItem of items) {
        const taskId = (taskItem.task_id as string) ?? "?";
        const currentStatus = (taskItem.status as string) ?? "pending";
        const description = (taskItem.description as string) ?? "";
        const reviewerFeedback = (taskItem.reviewer_feedback as string) ?? null;
        const retryCount = (taskItem.retry_count as number) ?? 0;
        const maxRetries = (taskItem.max_retries as number) ?? 2;

        let assignedTo: string;
        let worker: WorkerBot | undefined;

        if (currentStatus === "reviewing" && reviewerBot) {
          assignedTo = reviewerBot.id;
          worker = workerBots[assignedTo];
        } else if (makerBot) {
          assignedTo = makerBot.id;
          worker = workerBots[assignedTo];
        } else {
          assignedTo = (taskItem.assigned_to as string) ?? "";
          worker = workerBots[assignedTo];
        }

        if (!worker) {
          out.push({
            taskId,
            previousStatus: currentStatus,
            assignedTo,
            workerName: assignedTo,
            success: false,
            output: "Worker not found",
            qualityScore: 0,
          });
          continue;
        }

        try {
          const healthy = await worker.healthCheck();
          if (!healthy) {
            out.push({
              taskId,
              previousStatus: currentStatus,
              assignedTo,
              workerName: worker.bot.name,
              success: false,
              output: "Worker unreachable (health check failed)",
              qualityScore: 0,
            });
            continue;
          }

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
            const result = taskItem.result as Record<string, unknown> | null;
            const makerOutput = result?.output ? String(result.output) : "No output";
            taskDescription = buildReviewPrompt(description, makerOutput);
            uiMessages.push(`👀 [${worker.bot.name}] reviewing ${taskId}...`);
          } else {
            uiMessages.push(`▶ [${worker.bot.name}] started ${taskId}`);
          }

          // Mark task as in_progress and broadcast so the dashboard updates immediately
          const taskIdx = taskQueue.findIndex((t) => (t.task_id as string) === taskId);
          if (taskIdx >= 0) {
            taskQueue[taskIdx] = { ...taskQueue[taskIdx], status: "in_progress", in_progress_at: new Date().toISOString() };
            workerEvents.emit("progress", { taskQueue: [...taskQueue] });
          }

          const worker_tier = (taskItem.worker_tier as WorkerTier) ?? "light";
          checkPulse(worker.bot.name);
          const result = await worker.executeTask(
            {
              task_id: taskId,
              description: taskDescription,
              priority: (taskItem.priority as string) ?? "MEDIUM",
              estimated_cost: 0,
            },
            { worker_tier },
          );
          checkPulse(worker.bot.name);

          let reviewVerdict: { approved: boolean; feedback: string } | undefined;
          if (currentStatus === "reviewing") {
            reviewVerdict = parseReviewVerdict(result.output);
          }

          out.push({
            taskId,
            previousStatus: currentStatus,
            assignedTo,
            workerName: worker.bot.name,
            success: result.success,
            output: result.output,
            qualityScore: result.quality_score,
            reviewVerdict,
          });
        } catch (error) {
          const detail = formatExecutionError(error);
          out.push({
            taskId,
            previousStatus: currentStatus,
            assignedTo,
            workerName: worker.bot.name,
            success: false,
            output: `Task execution failed: ${detail}`,
            qualityScore: 0,
          });
        }
      }
      return out;
    };

    const groupedResults = await Promise.all(
      Array.from(groups.values()).map((items) => processGroup(items)),
    );
    for (const arr of groupedResults) records.push(...arr);

    const byTask = new Map(records.map((r) => [r.taskId, r]));
    for (let i = 0; i < taskQueue.length; i++) {
      const id = (taskQueue[i].task_id as string) ?? "";
      const rec = byTask.get(id);
      if (!rec) continue;

      const currentRetry = (taskQueue[i].retry_count as number) ?? 0;
      const maxRetries = (taskQueue[i].max_retries as number) ?? 2;
      let newStatus: string;
      let newAssignedTo = rec.assignedTo;
      let newFeedback: string | null = null;
      let newRetryCount = currentRetry;

      if (rec.previousStatus === "reviewing" && rec.reviewVerdict) {
        if (rec.reviewVerdict.approved) {
          newStatus = "waiting_for_human";
          uiMessages.push(`\u0007✅ [${rec.workerName}] approved ${id} - awaiting human final approval`);
        } else {
          newRetryCount = currentRetry + 1;
          if (newRetryCount > maxRetries) {
            newStatus = "failed";
            uiMessages.push(`❌ [${rec.workerName}] failed: ${id}`);
          } else {
            newStatus = "needs_rework";
            newAssignedTo = makerBot?.id ?? rec.assignedTo;
            newFeedback = rec.reviewVerdict.feedback;
            uiMessages.push(`🔄 [${rec.workerName}] rework: ${id}`);
          }
        }
      } else if (rec.previousStatus === "needs_rework") {
        newStatus = "reviewing";
        newAssignedTo = reviewerBot?.id ?? rec.assignedTo;
        uiMessages.push(`📝 [${rec.workerName}] rework done: ${id}`);
      } else if (rec.success) {
        if (hasReviewer && reviewerBot) {
          newStatus = "reviewing";
          newAssignedTo = reviewerBot.id;
          uiMessages.push(`✅ [${rec.workerName}] done: ${id} → review`);
          if (!taskQueue[i].original_maker) {
            taskQueue[i].original_maker = rec.assignedTo;
          }
        } else {
          newStatus = "completed";
          uiMessages.push(`✅ [${rec.workerName}] completed: ${id}`);
        }
      } else {
        newStatus = "failed";
        uiMessages.push(`❌ [${rec.workerName}] error: ${id}`);
      }

      taskQueue[i] = {
        ...taskQueue[i],
        status: newStatus,
        assigned_to: newAssignedTo,
        retry_count: newRetryCount,
        reviewer_feedback: newFeedback,
        result: {
          task_id: rec.taskId,
          success: rec.success,
          output: rec.output,
          quality_score: rec.qualityScore,
        },
      };

      if (newStatus === "completed") {
        const stats = botStats[rec.assignedTo] ?? { tasks_completed: 0, tasks_failed: 0, reworks_triggered: 0 };
        botStats[rec.assignedTo] = {
          ...stats,
          tasks_completed: ((stats.tasks_completed as number) ?? 0) + 1,
        };
      } else if (newStatus === "failed") {
        const stats = botStats[rec.assignedTo] ?? { tasks_completed: 0, tasks_failed: 0, reworks_triggered: 0 };
        botStats[rec.assignedTo] = {
          ...stats,
          tasks_failed: ((stats.tasks_failed as number) ?? 0) + 1,
        };
      }

      if (rec.previousStatus === "reviewing" && rec.reviewVerdict && !rec.reviewVerdict.approved) {
        for (const bot of Object.values(workerBots)) {
          if (bot.bot.role_id === "qa_reviewer") {
            const stats = botStats[bot.bot.id] ?? { tasks_completed: 0, tasks_failed: 0, reworks_triggered: 0 };
            botStats[bot.bot.id] = {
              ...stats,
              reworks_triggered: ((stats.reworks_triggered as number) ?? 0) + 1,
            };
            break;
          }
        }
      }
    }

    const agentMessages = [...(state.agent_messages ?? []), ...standupMessages];
    for (const rec of records) {
      if (!rec.output) continue;
      const ts = new Date().toTimeString().slice(0, 8);
      const summary = rec.output.slice(0, 120).replace(/\n/g, " ");
      const action = rec.previousStatus === "reviewing" ? "reviewed" : "completed";
      agentMessages.push({
        from_bot: rec.assignedTo,
        to_bot: "all",
        content: `Task ${rec.taskId} ${action}: ${summary}${rec.output.length > 120 ? "..." : ""}`,
        timestamp: ts,
      });
    }

    const avgQuality =
      records.length > 0
        ? Math.round(
            (records.reduce((sum, r) => sum + (Number.isFinite(r.qualityScore) ? r.qualityScore : 0), 0) /
              records.length) *
              100,
          )
        : 0;

    return {
      task_queue: taskQueue,
      bot_stats: botStats,
      agent_messages: agentMessages,
      last_action: `Dispatched ${records.length} task(s) across ${groups.size} gateway group(s)`,
      messages: uiMessages,
      last_quality_score: avgQuality,
      deep_work_mode: true,
      last_pulse_timestamp: lastPulseTime,
      __node__: "worker_execute",
    };
  };
}

