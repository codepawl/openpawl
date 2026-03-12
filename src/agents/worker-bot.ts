/**
 * Worker Bot - Executes tasks via WorkerAdapter.
 * Supports cross-review workflow: Maker -> QA Reviewer -> (rework) -> Maker
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

function formatExecutionError(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack?.trim();
    return stack && stack.length > 0 ? stack : err.message;
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const response = obj.response as { data?: unknown; status?: unknown } | undefined;
    if (response?.data != null) {
      return `HTTP ${String(response.status ?? "unknown")}: ${String(response.data)}`;
    }
    const message = obj.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return String(err);
}

export type WorkerTier = "light" | "heavy";

function parseReviewVerdict(output: string): { approved: boolean; feedback: string } {
  const upper = output.toUpperCase();
  const approvedMatch = upper.match(/APPROVED/);
  const rejectedMatch = upper.match(/REJECTED/i);
  
  if (approvedMatch && !rejectedMatch) {
    return { approved: true, feedback: "" };
  }
  
  if (rejectedMatch) {
    const feedbackMatch = output.match(/REJECTED[,:]?\s*(.+)/i);
    const feedback = feedbackMatch ? feedbackMatch[1].trim() : "No specific feedback provided";
    return { approved: false, feedback };
  }
  
  return { approved: false, feedback: "No clear APPROVED/REJECTED verdict found in response" };
}

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

    const pending = taskQueue.filter((t) => t.status === "pending" || t.status === "needs_rework");
    const reviewing = taskQueue.filter((t) => t.status === "reviewing");

    if (pending.length === 0 && reviewing.length === 0) {
      return { last_action: "No pending tasks", __node__: "worker_execute" };
    }

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
    const uiMessages: string[] = [];

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

          if (currentStatus === "needs_rework" && reviewerFeedback) {
            taskDescription = `${description}\n\n--- REWORK REQUEST ---\nYour previous output was rejected. Feedback: ${reviewerFeedback}\nPlease fix the issues and provide an improved version.`;
            uiMessages.push(`🔧 [${worker.bot.name}] reworking ${taskId} (attempt ${retryCount + 1}/${maxRetries + 1})`);
          } else if (currentStatus === "reviewing") {
            const result = taskItem.result as Record<string, unknown> | null;
            const makerOutput = result?.output ? String(result.output) : "No output";
            taskDescription = `Review the following task output and determine if it meets the requirements.\n\nTASK: ${description}\n\nMAKER'S OUTPUT:\n${makerOutput}\n\nRespond with:\n- "APPROVED" if the output is satisfactory\n- "REJECTED" with specific feedback if issues need to be fixed`;
            uiMessages.push(`👀 [${worker.bot.name}] reviewing ${taskId}...`);
          } else {
            uiMessages.push(`▶ [${worker.bot.name}] implementing ${taskId}...`);
          }

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
          uiMessages.push(`✅ [${rec.workerName}] approved ${id} - awaiting human final approval`);
        } else {
          newRetryCount = currentRetry + 1;
          if (newRetryCount > maxRetries) {
            newStatus = "failed";
            uiMessages.push(`❌ [${rec.workerName}] rejected ${id} after ${maxRetries} attempts - marked as failed`);
          } else {
            newStatus = "needs_rework";
            newAssignedTo = makerBot?.id ?? rec.assignedTo;
            newFeedback = rec.reviewVerdict.feedback;
            uiMessages.push(`❌ [${rec.workerName}] rejected ${id}: "${rec.reviewVerdict.feedback}" - sending back for rework`);
          }
        }
      } else if (rec.previousStatus === "needs_rework") {
        newStatus = "reviewing";
        newAssignedTo = reviewerBot?.id ?? rec.assignedTo;
        uiMessages.push(`📝 [${rec.workerName}] completed rework for ${id} - ready for review`);
      } else if (rec.success) {
        if (hasReviewer && reviewerBot) {
          newStatus = "reviewing";
          newAssignedTo = reviewerBot.id;
          if (!taskQueue[i].original_maker) {
            taskQueue[i].original_maker = rec.assignedTo;
          }
        } else {
          newStatus = "completed";
        }
      } else {
        newStatus = "failed";
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

    const agentMessages = [...(state.agent_messages ?? [])];
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
      __node__: "worker_execute",
    };
  };
}

