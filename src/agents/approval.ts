/**
 * Approval node - Human-in-the-loop for tasks requiring review.
 * Supports Approve, Edit, and Feedback (directives to Coordinator).
 */

import { select, text } from "@clack/prompts";
import type { GraphState } from "../core/graph-state.js";
import { getApprovalKeywords } from "../core/config.js";

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

export function createHumanApprovalNode(
  autoApprove: boolean = false
): (state: GraphState) => Promise<Partial<GraphState>> {
  let sessionAutoApprove = autoApprove;

  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const waitingTask = getFirstTaskWaitingForHuman(state);

    if (!waitingTask) {
      return { last_action: "No task waiting for human approval", __node__: "human_approval" };
    }

    if (sessionAutoApprove) {
      const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];
      const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);
      if (idx >= 0) {
        taskQueue[idx] = { ...taskQueue[idx], status: "completed" };
      }
      return {
        task_queue: taskQueue,
        messages: [`✅ Task ${waitingTask.task_id} auto-approved by human`],
        last_action: "Human approval: auto-approved",
        __node__: "human_approval",
      };
    }

    const canRenderSpinner = Boolean(
      process.stdout.isTTY && process.stderr.isTTY
    );

    if (!canRenderSpinner) {
      const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];
      const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);
      if (idx >= 0) {
        taskQueue[idx] = { ...taskQueue[idx], status: "completed" };
      }
      return {
        task_queue: taskQueue,
        messages: [`✅ Task ${waitingTask.task_id} auto-approved (non-TTY)`],
        last_action: "Human approval: auto-approved (non-TTY)",
        __node__: "human_approval",
      };
    }

    const truncatedDesc = waitingTask.description.length > 60
      ? waitingTask.description.slice(0, 60) + "..."
      : waitingTask.description;

    const decision = await select({
      message: `Task "${truncatedDesc}" has passed QA. What would you like to do?`,
      options: [
        { value: "yes", label: "✅ Approve this task" },
        { value: "no", label: "❌ Reject and provide feedback" },
        { value: "all", label: "🚀 Approve this and ALL remaining tasks (Yes to All)" },
      ],
    });

    const taskQueue = [...(state.task_queue ?? [])] as Record<string, unknown>[];
    const idx = taskQueue.findIndex((t) => t.task_id === waitingTask.task_id);

    if (decision === "yes" || decision === "all") {
      if (decision === "all") {
        sessionAutoApprove = true;
      }
      if (idx >= 0) {
        taskQueue[idx] = { ...taskQueue[idx], status: "completed" };
      }
      const msg = decision === "all"
        ? "Auto-approve enabled for the rest of this session."
        : `✅ Task ${waitingTask.task_id} approved by human`;
      return {
        task_queue: taskQueue,
        messages: [msg],
        last_action: `Human approval: ${decision === "all" ? "approved all" : "approved"}`,
        __node__: "human_approval",
      };
    }

    const feedback = await text({
      message: "Enter your feedback for the Maker to fix:",
      placeholder: "Please fix the following issues...",
    });

    const feedbackStr = String(feedback).trim();
    if (idx >= 0) {
      taskQueue[idx] = {
        ...taskQueue[idx],
        status: "needs_rework",
        reviewer_feedback: `HUMAN FEEDBACK: ${feedbackStr}. Please fix this.`,
        retry_count: 0,
      };
    }

    return {
      task_queue: taskQueue,
      messages: [`❌ Task ${waitingTask.task_id} rejected by human: "${feedbackStr}"`],
      last_action: "Human approval: rejected with feedback",
      __node__: "human_approval",
    };
  };
}
