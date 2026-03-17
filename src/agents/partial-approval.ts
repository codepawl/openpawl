/**
 * Partial approval node — per-task approve/reject/escalate flow.
 * Replaces the all-or-nothing human_approval node.
 */

import { select, text } from "@clack/prompts";
import pc from "picocolors";
import type { GraphState } from "../core/graph-state.js";
import { extractSuccessPattern } from "../memory/success/extractor.js";
import type { TaskForExtraction } from "../memory/success/extractor.js";
import { detectCoordinatorIntervention } from "../personality/coordinator-intervention.js";
import { CONFIG } from "../core/config.js";

export interface PartialApprovalTask {
  task_id: string;
  description: string;
  assigned_to: string;
  confidence_score: number | null;
  routing_decision: string | null;
  is_auto_approved: boolean;
  rework_count: number;
}

export type ApprovalAction = "approve" | "reject" | "escalate";

export interface PartialApprovalDecision {
  action: ApprovalAction;
  feedback?: string;
}

export type PerTaskApprovalProvider = (
  tasks: PartialApprovalTask[],
) => Promise<Map<string, PartialApprovalDecision>>;

function toPartialApprovalTask(t: Record<string, unknown>): PartialApprovalTask {
  const result = t.result as Record<string, unknown> | null;
  const confidence = result?.confidence as { score: number } | undefined;
  const status = t.status as string;
  return {
    task_id: (t.task_id as string) ?? "",
    description: (t.description as string) ?? "",
    assigned_to: (t.assigned_to as string) ?? "",
    confidence_score: confidence?.score ?? null,
    routing_decision: (result?.routing_decision as string) ?? null,
    is_auto_approved: status === "auto_approved_pending",
    rework_count: (t.retry_count as number) ?? 0,
  };
}

export function createPartialApprovalNode(options: {
  autoApprove?: boolean;
  approvalProvider?: PerTaskApprovalProvider | null;
  maxRetries?: number;
}): (state: GraphState) => Promise<Partial<GraphState>> {
  let sessionAutoApprove = options.autoApprove ?? false;
  const maxRetries = options.maxRetries ?? 2;

  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const taskQueue = state.task_queue ?? [];

    // Coordinator personality intervention: auto-resolve stuck rework loops
    const interventionMessages: string[] = [];
    if (CONFIG.personalityEnabled && CONFIG.personalityCoordinatorIntervention) {
      const intervention = detectCoordinatorIntervention(state);
      if (intervention) {
        interventionMessages.push(`Coordinator Intervention: ${intervention.message}`);
        // Auto-approve the stuck task at current confidence
        const stuckIdx = taskQueue.findIndex(
          (t) => (t.task_id as string) === intervention.taskId,
        );
        if (stuckIdx !== -1) {
          taskQueue[stuckIdx] = { ...taskQueue[stuckIdx], status: "completed" };
        }
      }
    }

    const waitingTasks = taskQueue.filter((t) => {
      const st = t.status as string;
      return st === "waiting_for_human" || st === "auto_approved_pending";
    });

    if (waitingTasks.length === 0) {
      return { last_action: "No tasks awaiting approval", __node__: "partial_approval" };
    }

    // Session-level auto-approve: mark all completed
    if (sessionAutoApprove) {
      const updated = waitingTasks.map((t) => ({ ...t, status: "completed" }));
      return {
        task_queue: updated,
        approval_stats: {
          autoApprovedCount: waitingTasks.length,
          rejectedCount: 0,
          escalatedCount: 0,
          manualApprovedCount: 0,
        },
        messages: [`✅ ${waitingTasks.length} task(s) auto-approved (session flag)`],
        last_action: "Partial approval: session auto-approve",
        __node__: "partial_approval",
      };
    }

    const canRenderSpinner = Boolean(process.stdout.isTTY && process.stderr.isTTY);

    // Non-TTY and no dashboard provider: auto-approve all
    if (!canRenderSpinner && !options.approvalProvider) {
      const updated = waitingTasks.map((t) => ({ ...t, status: "completed" }));
      return {
        task_queue: updated,
        approval_stats: {
          autoApprovedCount: waitingTasks.length,
          rejectedCount: 0,
          escalatedCount: 0,
          manualApprovedCount: 0,
        },
        messages: [`✅ ${waitingTasks.length} task(s) auto-approved (non-TTY)`],
        last_action: "Partial approval: auto-approved (non-TTY)",
        __node__: "partial_approval",
      };
    }

    const approvalTasks = waitingTasks.map(toPartialApprovalTask);
    const autoTasks = approvalTasks.filter((t) => t.is_auto_approved);
    const manualTasks = approvalTasks.filter((t) => !t.is_auto_approved);

    let decisions: Map<string, PartialApprovalDecision>;

    // All auto-approved, no manual: skip waiting, approve immediately
    if (manualTasks.length === 0 && autoTasks.length > 0) {
      decisions = new Map<string, PartialApprovalDecision>();
      for (const t of autoTasks) {
        decisions.set(t.task_id, { action: "approve" });
      }
    } else if (options.approvalProvider) {
      // Dashboard path: delegate to provider (handles 10s auto-approve window internally)
      decisions = await options.approvalProvider(approvalTasks);
    } else {
      // CLI path: sequential per-task prompts
      decisions = await cliApprovalFlow(approvalTasks);
    }

    // Apply decisions
    const updatedTasks: Record<string, unknown>[] = [];
    const escalatedTasks: Record<string, unknown>[] = [];
    let autoApprovedCount = 0;
    let manualApprovedCount = 0;
    let rejectedCount = 0;
    let escalatedCount = 0;

    for (const wt of waitingTasks) {
      const taskId = wt.task_id as string;
      const decision = decisions.get(taskId);
      if (!decision) {
        // No decision — default approve
        updatedTasks.push({ ...wt, status: "completed" });
        autoApprovedCount++;
        continue;
      }

      const approvalTask = approvalTasks.find((t) => t.task_id === taskId);

      switch (decision.action) {
        case "approve": {
          updatedTasks.push({ ...wt, status: "completed" });
          if (approvalTask?.is_auto_approved) {
            autoApprovedCount++;
          } else {
            manualApprovedCount++;
          }
          break;
        }
        case "reject": {
          if (!decision.feedback?.trim()) {
            throw new Error(`Feedback is required when rejecting task ${taskId}`);
          }
          const retryCount = (wt.retry_count as number) ?? 0;
          if (retryCount >= maxRetries) {
            // Force escalate if at max retries
            updatedTasks.push({ ...wt, status: "escalated" });
            escalatedTasks.push(wt);
            escalatedCount++;
          } else {
            updatedTasks.push({
              ...wt,
              status: "needs_rework",
              reviewer_feedback: `HUMAN FEEDBACK: ${decision.feedback}`,
            });
            rejectedCount++;
          }
          break;
        }
        case "escalate": {
          updatedTasks.push({ ...wt, status: "escalated" });
          escalatedTasks.push(wt);
          escalatedCount++;
          break;
        }
      }
    }

    // Check if user chose "approve all session"
    // (CLI sets this via a special marker in the decision map)
    const sessionMarker = decisions.get("__session_auto_approve__");
    if (sessionMarker) {
      sessionAutoApprove = true;
    }

    // Extract success patterns from newly-completed tasks
    const newPatternIds: string[] = [];
    const goalContext = state.user_goal ?? "";
    for (const task of updatedTasks) {
      const status = task.status as string;
      if (status === "completed") {
        const taskForExtraction: TaskForExtraction = {
          task_id: (task.task_id as string) ?? "",
          description: (task.description as string) ?? "",
          assigned_to: (task.assigned_to as string) ?? "",
          status,
          retry_count: (task.retry_count as number) ?? 0,
          result: (task.result as TaskForExtraction["result"]) ?? null,
        };
        const pattern = extractSuccessPattern(
          taskForExtraction,
          goalContext,
          "", // sessionId filled by work-runner
          0,  // runIndex filled by work-runner
        );
        if (pattern) {
          newPatternIds.push(JSON.stringify(pattern));
        }
      }
    }

    const stats = {
      autoApprovedCount,
      rejectedCount,
      escalatedCount,
      manualApprovedCount,
    };

    const summaryParts: string[] = [];
    if (autoApprovedCount > 0) summaryParts.push(`✓ Auto-approved: ${autoApprovedCount}`);
    if (manualApprovedCount > 0) summaryParts.push(`✓ Approved: ${manualApprovedCount}`);
    if (rejectedCount > 0) summaryParts.push(`✗ Rejected (rework): ${rejectedCount}`);
    if (escalatedCount > 0) summaryParts.push(`→ Escalated: ${escalatedCount}`);
    const summary = `Review summary: ${summaryParts.join(" | ")}`;

    return {
      task_queue: updatedTasks,
      next_sprint_backlog: escalatedTasks,
      new_success_patterns: newPatternIds,
      approval_stats: stats,
      messages: [...interventionMessages, summary],
      last_action: `Partial approval: ${summaryParts.join(", ")}`,
      __node__: "partial_approval",
    };
  };
}

async function cliApprovalFlow(
  tasks: PartialApprovalTask[],
): Promise<Map<string, PartialApprovalDecision>> {
  const decisions = new Map<string, PartialApprovalDecision>();

  const header = pc.bold(
    pc.yellow(`\nSprint complete — ${tasks.length} task(s) ready for review\n`),
  );
  process.stdout.write(header);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const confidenceStr = task.confidence_score !== null
      ? `${Math.round(task.confidence_score * 100)}%`
      : "N/A";
    const autoLabel = task.is_auto_approved ? pc.green(" [Auto]") : "";

    const message = `[${i + 1}/${tasks.length}] ${task.description.slice(0, 60)}${task.description.length > 60 ? "..." : ""}
Agent: ${task.assigned_to} | Confidence: ${confidenceStr}${autoLabel}`;

    const decision = await select({
      message,
      options: [
        { value: "approve", label: "✅ Approve" },
        { value: "reject", label: "❌ Reject and rework" },
        { value: "escalate", label: "→ Escalate to next sprint" },
        ...(i === 0 ? [{ value: "approve_all", label: "🚀 Approve ALL (including future tasks)" }] : []),
      ],
    });

    if (decision === "approve_all") {
      // Approve this and all remaining tasks
      for (let j = i; j < tasks.length; j++) {
        decisions.set(tasks[j].task_id, { action: "approve" });
      }
      decisions.set("__session_auto_approve__", { action: "approve" });
      break;
    }

    if (decision === "reject") {
      const feedback = await text({
        message: "Enter feedback for the worker:",
        placeholder: "Please fix the following issues...",
        validate: (v) => (!v.trim() ? "Feedback is required" : undefined),
      });
      decisions.set(task.task_id, { action: "reject", feedback: String(feedback).trim() });
    } else {
      decisions.set(task.task_id, { action: decision as ApprovalAction });
    }
  }

  return decisions;
}
