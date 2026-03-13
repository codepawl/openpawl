/**
 * Approval node - Human-in-the-loop for tasks requiring review.
 * Supports Approve, Edit, and Feedback (directives to Coordinator).
 */

import { select, text, cancel } from "@clack/prompts";
import pc from "picocolors";
import type { GraphState } from "../core/graph-state.js";
import { getApprovalKeywords } from "../core/config.js";
import { getCanvasTelemetry } from "../core/canvas-telemetry.js";

export interface ApprovalPending {
  task_id: string;
  description: string;
  assigned_to: string;
  priority: string;
}

export interface ApprovalResponse {
  action: "approved" | "edited" | "feedback";
  edited_task?: { description: string };
  feedback?: string;
}

export type ApprovalProvider = (pending: ApprovalPending) => Promise<ApprovalResponse>;

function taskNeedsApproval(
  task: Record<string, unknown>,
  keywords: string[]
): boolean {
  const prio = (task.priority as string) ?? "";
  if (prio === "HIGH") return true;
  const desc = ((task.description as string) ?? "").toLowerCase();
  return keywords.some((k) => desc.includes(k.toLowerCase()));
}

export function getFirstTaskNeedingApproval(
  state: GraphState,
  keywords: string[] = []
): ApprovalPending | null {
  const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
  const pending = taskQueue.filter((t) => (t.status as string) === "pending");
  const kws = keywords.length > 0 ? keywords : getApprovalKeywords();
  for (const t of pending) {
    if (taskNeedsApproval(t, kws)) {
      return {
        task_id: (t.task_id as string) ?? "",
        description: (t.description as string) ?? "",
        assigned_to: (t.assigned_to as string) ?? "",
        priority: (t.priority as string) ?? "MEDIUM",
      };
    }
  }
  return null;
}

export function createApprovalNode(
  approvalProvider: ApprovalProvider | null
): (state: GraphState) => Promise<Partial<GraphState>> {
  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const keywords = getApprovalKeywords();
    const pending = getFirstTaskNeedingApproval(state, keywords);
    if (!pending) {
      return { last_action: "No task needs approval", __node__: "approval" };
    }

    let response: ApprovalResponse;
    if (approvalProvider) {
      response = await approvalProvider(pending);
    } else {
      response = { action: "approved" };
    }

    const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];
    const idx = taskQueue.findIndex((t) => t.task_id === pending.task_id);

    if (response.action === "edited" && response.edited_task && idx >= 0) {
      taskQueue[idx] = {
        ...taskQueue[idx],
        description: response.edited_task.description,
      };
    }

    let userGoal = state.user_goal as string | null;
    if (response.action === "feedback" && response.feedback && idx >= 0) {
      const taskDesc = (taskQueue[idx]?.description as string) ?? "";
      userGoal = `[User feedback on task "${taskDesc.slice(0, 80)}..."]: ${response.feedback}. Revise the plan accordingly.`;
      taskQueue.splice(idx, 1);
    }

    return {
      approval_pending: null,
      approval_response: response as unknown as Record<string, unknown>,
      task_queue: taskQueue,
      user_goal: userGoal ?? undefined,
      messages: [
        response.action === "approved"
          ? `✅ Task ${pending.task_id} approved`
          : response.action === "edited"
            ? `📝 Task ${pending.task_id} edited`
            : `💬 Feedback for ${pending.task_id}: ${response.feedback}`,
      ],
      last_action: `Approval: ${response.action}`,
      __node__: "approval",
    };
  };
}

export function getFirstTaskWaitingForHuman(
  state: GraphState
): { task_id: string; description: string; assigned_to: string } | null {
  const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
  const waiting = taskQueue.filter((t) => (t.status as string) === "waiting_for_human");
  if (waiting.length === 0) return null;
  const t = waiting[0];
  return {
    task_id: (t.task_id as string) ?? "",
    description: (t.description as string) ?? "",
    assigned_to: (t.assigned_to as string) ?? "",
  };
}

export function getAllTasksWaitingForHuman(
  state: GraphState
): Array<{ task_id: string; description: string; assigned_to: string }> {
  const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
  const waiting = taskQueue.filter((t) => (t.status as string) === "waiting_for_human");
  return waiting.map((t) => ({
    task_id: (t.task_id as string) ?? "",
    description: (t.description as string) ?? "",
    assigned_to: (t.assigned_to as string) ?? "",
  }));
}

export function createHumanApprovalNode(
  autoApprove: boolean = false,
  approvalProvider?: ApprovalProvider
): (state: GraphState) => Promise<Partial<GraphState>> {
  let sessionAutoApprove = autoApprove;
  const telemetry = getCanvasTelemetry();

  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const waitingTasks = getAllTasksWaitingForHuman(state);

    if (waitingTasks.length === 0) {
      return { last_action: "No task waiting for human approval", __node__: "human_approval" };
    }

    if (sessionAutoApprove) {
      const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];
      for (const waitingTask of waitingTasks) {
        const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);
        if (idx >= 0) {
          taskQueue[idx] = { ...taskQueue[idx], status: "completed" };
        }
      }
      return {
        task_queue: taskQueue,
        messages: [`✅ ${waitingTasks.length} task(s) auto-approved by human`],
        last_action: "Human approval: auto-approved",
        __node__: "human_approval",
      };
    }

    const canRenderSpinner = Boolean(
      process.stdout.isTTY && process.stderr.isTTY
    );

    if (!canRenderSpinner) {
      const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];
      for (const waitingTask of waitingTasks) {
        const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);
        if (idx >= 0) {
          taskQueue[idx] = { ...taskQueue[idx], status: "completed" };
        }
      }
      return {
        task_queue: taskQueue,
        messages: [`✅ ${waitingTasks.length} task(s) auto-approved (non-TTY)`],
        last_action: "Human approval: auto-approved (non-TTY)",
        __node__: "human_approval",
      };
    }

    const warningHeader = pc.bold(pc.yellow("⚠️ Human input required!"));
    const taskList = waitingTasks.map((t, i) => 
      `  ${i + 1}. ${t.task_id}: ${t.description.slice(0, 50)}${t.description.length > 50 ? "..." : ""}`
    ).join("\n");

    const pending: ApprovalPending = {
      task_id: waitingTasks[0].task_id,
      description: waitingTasks[0].description,
      assigned_to: waitingTasks[0].assigned_to,
      priority: "HIGH",
    };

    const message = `${warningHeader}\n\nThe following task(s) are ready for your review:\n${taskList}\n\nWhat would you like to do?`;

    for (const task of waitingTasks) {
      telemetry.sendWaitingForHuman(task.task_id, `Task requires approval: ${task.description.slice(0, 100)}`);
    }

    const abortController = new AbortController();
    let cliCompleted = false;

    const wsPromise = approvalProvider
      ? approvalProvider(pending).then((response) => ({ source: "ws" as const, response }))
      : new Promise<never>((_, reject) => {
          abortController.signal.addEventListener("abort", () => reject(new Error("No approval provider")));
        });

    const cliPromise = (async () => {
      try {
        const decision = await select({
          message,
          options: [
            { value: "yes", label: "✅ Approve all task(s)" },
            { value: "no", label: "❌ Reject and provide feedback" },
            { value: "all", label: "🚀 Approve ALL (including future tasks this session)" },
          ],
        });

        cliCompleted = true;

        if (decision === "yes" || decision === "all") {
          return { source: "cli" as const, decision, feedback: undefined };
        }

        const feedback = await text({
          message: "Enter your feedback for the Maker to fix:",
          placeholder: "Please fix the following issues...",
        });

        return { source: "cli" as const, decision: "no", feedback: String(feedback).trim() };
      } catch (err) {
        if (abortController.signal.aborted) {
          cliCompleted = true;
          throw new Error("CLI_CANCELLED");
        }
        throw err;
      }
    })();

    let wsResolved = false;
    let wsRejected = false;
    let result: { source: "ws"; response: ApprovalResponse } | { source: "cli"; decision: string; feedback?: string };

    wsPromise.then(() => {
      wsResolved = true;
    }).catch(() => {
      wsRejected = true;
    });

    try {
      result = await Promise.race([wsPromise, cliPromise]);
    } catch (err) {
      if (err instanceof Error && err.message === "CLI_CANCELLED") {
        if (wsResolved) {
          process.stdout.write("\n✅ Task resolved via Web Dashboard\n");
          const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];
          return {
            task_queue: taskQueue,
            messages: [`✅ Task(s) resolved via Web Dashboard`],
            last_action: "Human approval: resolved via Dashboard",
            __node__: "human_approval",
          };
        }
        if (wsRejected) {
          process.stdout.write("\n⚠️ Web Dashboard approval failed, using CLI\n");
        }
        throw err;
      }
      if (wsRejected) {
        process.stdout.write("\n⚠️ Web Dashboard approval failed, using CLI\n");
      }
      throw err;
    }

    if (result.source === "ws") {
      abortController.abort();
      
      if (!cliCompleted) {
        cancel();
        process.stdout.write("\r" + " ".repeat(process.stdout.columns || 80) + "\r");
        process.stdout.write("✅ Task resolved via Web Dashboard\n");
      }

      const response = result.response;
      const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];

      if (response.action === "approved") {
        for (const waitingTask of waitingTasks) {
          const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);
          if (idx >= 0) {
            taskQueue[idx] = { ...taskQueue[idx], status: "completed" };
          }
        }
        const taskIds = waitingTasks.map(t => t.task_id).join(", ");
        return {
          task_queue: taskQueue,
          messages: [`✅ Approved via Dashboard: ${taskIds}`],
          last_action: "Human approval: approved via Dashboard",
          __node__: "human_approval",
        };
      }

      if (response.action === "feedback" || response.action === "edited") {
        const feedbackStr = response.feedback ?? "";
        const rejectedTasks: string[] = [];

        for (const waitingTask of waitingTasks) {
          const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);
          if (idx >= 0) {
            taskQueue[idx] = {
              ...taskQueue[idx],
              status: "needs_rework",
              reviewer_feedback: `HUMAN FEEDBACK: ${feedbackStr}. Please fix this.`,
              retry_count: 0,
            };
            rejectedTasks.push(waitingTask.task_id);
          }
        }

        return {
          task_queue: taskQueue,
          messages: [`❌ Rejected via Dashboard: ${rejectedTasks.join(", ")} — "${feedbackStr}"`],
          last_action: "Human approval: rejected via Dashboard",
          __node__: "human_approval",
        };
      }

      return { last_action: "Human approval: unknown response", __node__: "human_approval" };
    }

    const { decision, feedback } = result;

    const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];

    if (decision === "yes" || decision === "all") {
      if (decision === "all") {
        sessionAutoApprove = true;
      }
      for (const waitingTask of waitingTasks) {
        const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);
        if (idx >= 0) {
          taskQueue[idx] = { ...taskQueue[idx], status: "completed" };
        }
      }
      const taskIds = waitingTasks.map(t => t.task_id).join(", ");
      const msg = decision === "all"
        ? `🚀 Auto-approve enabled for remaining tasks`
        : `✅ Approved: ${taskIds}`;
      return {
        task_queue: taskQueue,
        messages: [msg],
        last_action: `Human approval: ${decision === "all" ? "approved all" : "approved"}`,
        __node__: "human_approval",
      };
    }

    const feedbackStr = feedback ?? "";
    const rejectedTasks: string[] = [];

    for (const waitingTask of waitingTasks) {
      const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);
      if (idx >= 0) {
        taskQueue[idx] = {
          ...taskQueue[idx],
          status: "needs_rework",
          reviewer_feedback: `HUMAN FEEDBACK: ${feedbackStr}. Please fix this.`,
          retry_count: 0,
        };
        rejectedTasks.push(waitingTask.task_id);
      }
    }

    return {
      task_queue: taskQueue,
      messages: [`❌ Rejected by human: ${rejectedTasks.join(", ")} — "${feedbackStr}"`],
      last_action: "Human approval: rejected with feedback",
      __node__: "human_approval",
    };
  };
}
