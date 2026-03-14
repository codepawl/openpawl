/**
 * Review Workflow — cross-review helpers extracted from worker-bot.
 * Handles review verdict parsing, error formatting, blocker assessment,
 * and standup message creation for the Maker → QA Reviewer → Rework cycle.
 */

export function formatExecutionError(err: unknown): string {
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

export function assessBlockers(taskItem: Record<string, unknown>): string {
  const complexity = (taskItem.complexity as string) ?? "MEDIUM";
  const workerTier = (taskItem.worker_tier as string) ?? "light";
  const description = (taskItem.description as string) ?? "";

  const blockers: string[] = [];

  if (complexity === "HIGH" || complexity === "ARCHITECTURE") {
    blockers.push("High complexity — may need RFC approval");
  }

  if (workerTier === "heavy") {
    blockers.push("Heavy tier — browser automation may be flaky");
  }

  if (description.length > 500) {
    blockers.push("Large scope — consider breaking down");
  }

  return blockers.length > 0 ? blockers.join("; ") : "None identified";
}

export function createStandupMessage(
  taskItem: Record<string, unknown>,
  _botName: string,
  botId: string,
  taskQueue: Record<string, unknown>[]
): { from_bot: string; to_bot: string; content: string; timestamp: string; type: string } {
  const taskId = (taskItem.task_id as string) ?? "?";
  const description = (taskItem.description as string) ?? "";

  const previousTasks = taskQueue.filter((t) => {
    const status = t.status as string;
    const tid = t.task_id as string;
    return status === "completed" && tid !== taskId;
  });

  const previousState = previousTasks.length > 0
    ? `Completed: ${previousTasks.slice(-3).map(t => t.task_id).join(", ")}${previousTasks.length > 3 ? "..." : ""}`
    : "None (first task in cycle)";

  const blockers = assessBlockers(taskItem);

  const content = `🎤 STAND-UP
- Working on: ${taskId} - ${description.slice(0, 100)}${description.length > 100 ? "..." : ""}
- Previous state: ${previousState}
- Potential Blockers: ${blockers}`;

  return {
    from_bot: botId,
    to_bot: "qa_reviewer",
    content,
    timestamp: new Date().toISOString(),
    type: "standup",
  };
}

export function parseReviewVerdict(output: string): { approved: boolean; feedback: string } {
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

/**
 * Build the review task description sent to the QA reviewer bot.
 */
export function buildReviewPrompt(taskDescription: string, makerOutput: string): string {
  return `Review the following task output and determine if it meets the requirements.\n\nTASK: ${taskDescription}\n\nMAKER'S OUTPUT:\n${makerOutput}\n\nRespond with:\n- "APPROVED" if the output is satisfactory\n- "REJECTED" with specific feedback if issues need to be fixed`;
}

/**
 * Build the rework task description sent back to the maker bot.
 */
export function buildReworkPrompt(
  originalDescription: string,
  reviewerFeedback: string,
  retryCount: number,
  maxRetries: number
): { description: string; uiLabel: string } {
  const description = `${originalDescription}\n\n--- REWORK REQUEST ---\nYour previous output was rejected. Feedback: ${reviewerFeedback}\nPlease fix the issues and provide an improved version.`;
  const uiLabel = `attempt ${retryCount + 1}/${maxRetries + 1}`;
  return { description, uiLabel };
}
