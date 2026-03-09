/**
 * Worker Bot - Executes tasks via WorkerAdapter.
 * Calls healthCheck before executeTask for fail-fast when worker is down.
 */

import type { GraphState } from "../core/graph-state.js";
import type { BotDefinition } from "../core/bot-definitions.js";
import type { WorkerAdapter } from "../interfaces/worker-adapter.js";
import { createRoutingAdapters } from "../interfaces/worker-adapter.js";
import { CONFIG } from "../core/config.js";
import type { TaskRequest, TaskResult } from "../core/state.js";
import { logger } from "../core/logger.js";

const OPENCLAW_UNAVAILABLE_MSG = "OpenClaw required but service unavailable";

function log(msg: string): void {
  if (CONFIG.verboseLogging) {
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
    options?: { worker_tier?: WorkerTier }
  ): Promise<TaskResult> {
    const worker_tier = options?.worker_tier ?? "light";
    const req: TaskRequest = {
      task_id: task.task_id,
      description: task.description,
      priority: task.priority ?? "MEDIUM",
      estimated_cost: task.estimated_cost ?? 0,
    };

    if (worker_tier === "heavy" && this.heavyAdapter) {
      const healthy = await this.heavyAdapter.healthCheck();
      if (!healthy) {
        log(`Heavy task ${task.task_id} failed: OpenClaw unavailable`);
        return {
          task_id: task.task_id,
          success: false,
          output: OPENCLAW_UNAVAILABLE_MSG,
          quality_score: 0,
        };
      }
      return this.heavyAdapter.executeTask(req);
    }

    return this.adapter.executeTask(req);
  }

  async healthCheck(): Promise<boolean> {
    return this.adapter.healthCheck();
  }
}

export function createWorkerBots(
  team: BotDefinition[],
  workerUrls: Record<string, string> = {}
): Record<string, WorkerBot> {
  const bots: Record<string, WorkerBot> = {};
  for (const bot of team) {
    const { light, heavy } = createRoutingAdapters(bot, workerUrls);
    bots[bot.id] = new WorkerBot(bot, light, heavy);
  }
  return bots;
}

export function createWorkerExecuteNode(
  workerBots: Record<string, WorkerBot>
): (state: GraphState) => Promise<Partial<GraphState>> {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const taskQueue = [...(state.task_queue ?? [])];
    const botStats = { ...(state.bot_stats ?? {}) };

    const pending = taskQueue.filter((t) => t.status === "pending");
    if (pending.length === 0) {
      return { last_action: "No pending tasks", __node__: "worker_execute" };
    }

    type ExecutionRecord = {
      taskId: string;
      assignedTo: string;
      workerName: string;
      success: boolean;
      output: string;
      qualityScore: number;
    };

    const groups = new Map<string, Array<Record<string, unknown>>>();
    const records: ExecutionRecord[] = [];
    const uiMessages: string[] = [];

    for (const taskItem of pending) {
      const taskId = (taskItem.task_id as string) ?? "?";
      const assignedTo = (taskItem.assigned_to as string) ?? "";
      const worker = workerBots[assignedTo];
      if (!worker) {
        records.push({
          taskId,
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

    const processGroup = async (items: Array<Record<string, unknown>>): Promise<ExecutionRecord[]> => {
      const out: ExecutionRecord[] = [];
      for (const taskItem of items) {
        const taskId = (taskItem.task_id as string) ?? "?";
        const assignedTo = (taskItem.assigned_to as string) ?? "";
        const description = (taskItem.description as string) ?? "";
        const worker = workerBots[assignedTo];
        if (!worker) {
          out.push({
            taskId,
            assignedTo,
            workerName: assignedTo,
            success: false,
            output: "Worker not found",
            qualityScore: 0,
          });
          continue;
        }

        const healthy = await worker.healthCheck();
        if (!healthy) {
          out.push({
            taskId,
            assignedTo,
            workerName: worker.bot.name,
            success: false,
            output: "Worker unreachable (health check failed)",
            qualityScore: 0,
          });
          continue;
        }

        const worker_tier = (taskItem.worker_tier as WorkerTier) ?? "light";
        const result = await worker.executeTask(
          {
            task_id: taskId,
            description,
            priority: (taskItem.priority as string) ?? "MEDIUM",
            estimated_cost: 0,
          },
          { worker_tier },
        );

        out.push({
          taskId,
          assignedTo,
          workerName: worker.bot.name,
          success: result.success,
          output: result.output,
          qualityScore: result.quality_score,
        });
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
      taskQueue[i] = {
        ...taskQueue[i],
        status: rec.success ? "completed" : "failed",
        result: {
          task_id: rec.taskId,
          success: rec.success,
          output: rec.output,
          quality_score: rec.qualityScore,
        },
      };
      const stats = botStats[rec.assignedTo] ?? { tasks_completed: 0, tasks_failed: 0 };
      botStats[rec.assignedTo] = {
        ...stats,
        tasks_completed: ((stats.tasks_completed as number) ?? 0) + (rec.success ? 1 : 0),
        tasks_failed: ((stats.tasks_failed as number) ?? 0) + (rec.success ? 0 : 1),
      };
      uiMessages.push(`🤖 ${rec.workerName}: ${rec.taskId} ${rec.success ? "✅" : "❌"}`);
    }

    const agentMessages = [...(state.agent_messages ?? [])];
    for (const rec of records) {
      if (!rec.success || !rec.output) continue;
      const ts = new Date().toTimeString().slice(0, 8);
      const summary = rec.output.slice(0, 120).replace(/\n/g, " ");
      agentMessages.push({
        from_bot: rec.assignedTo,
        to_bot: "all",
        content: `Task ${rec.taskId} done: ${summary}${rec.output.length > 120 ? "..." : ""}`,
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
      __node__: "worker_execute",
    };
  };
}

