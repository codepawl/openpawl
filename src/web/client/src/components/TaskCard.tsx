import { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useTimeboxCountdown } from "../hooks/useTimeboxCountdown";
import { useWsStore } from "../ws/store";

export interface TaskCardProps {
  task: Record<string, unknown>;
}

function getPriorityBadgeColor(priority: string): string {
  const p = (priority as string || "MEDIUM").toUpperCase();
  if (p === "HIGH") return "bg-rose-100 dark:bg-rose-900/50 text-rose-800 dark:text-rose-300";
  if (p === "LOW") return "bg-stone-100 dark:bg-stone-700 text-stone-700 dark:text-stone-300";
  return "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300";
}

function getConfidenceBadgeColor(score: number): string {
  if (score >= 0.85) return "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-300";
  if (score >= 0.60) return "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300";
  if (score >= 0.40) return "bg-orange-100 dark:bg-orange-900/50 text-orange-800 dark:text-orange-300";
  return "bg-rose-100 dark:bg-rose-900/50 text-rose-800 dark:text-rose-300";
}

function getRoutingLabel(decision: string): string {
  switch (decision) {
    case "auto_approved": return "Auto-approved";
    case "qa_review": return "QA Review";
    case "rework": return "Rework";
    case "escalated": return "Escalated";
    default: return decision;
  }
}

export function TaskCard({ task }: TaskCardProps) {
  const taskId = (task.task_id as string) ?? "?";
  const description = (task.description as string) ?? "";
  const assignedTo = (task.assigned_to as string) ?? "";
  const priority = (task.priority as string) ?? "MEDIUM";
  const status = (task.status as string) ?? "pending";

  const result = task.result as Record<string, unknown> | null;
  const confidence = result?.confidence as { score: number; reasoning: string; flags: string[] } | undefined;
  const routingDecision = result?.routing_decision as string | undefined;

  const { remainingSeconds, isExpired } = useTimeboxCountdown(task);
  const reasoning = useWsStore((s) => s.reasoning[taskId]);
  const streamingEntry = useWsStore((s) => s.streamingText[assignedTo]);
  const pendingTaskApprovals = useWsStore((s) => s.pendingTaskApprovals);
  const sendCommand = useWsStore((s) => s.sendCommand);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showStreaming, setShowStreaming] = useState(true);
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

  const isPendingApproval = pendingTaskApprovals.some(
    (t) => (t.task_id as string) === taskId,
  );
  const isAutoApproved = status === "auto_approved_pending";

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: taskId,
    data: task,
  });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`rounded-xl bg-gradient-to-br from-white to-stone-50 dark:from-stone-800 dark:to-stone-900 p-3.5 shadow-sm transition-all cursor-grab active:cursor-grabbing animate-card-in ${
        isDragging ? "opacity-50 shadow-lg" : "hover:shadow"
      } ${
        status === "TIMEOUT_WARNING"
          ? "border-2 border-rose-500 animate-pulse"
          : "border border-stone-200 dark:border-stone-700"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-stone-500 dark:text-stone-400">{taskId}</span>
        <div className="flex items-center gap-1.5">
          {confidence && (
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-medium ${getConfidenceBadgeColor(confidence.score)}`}
              title={`${confidence.reasoning}${confidence.flags.length > 0 ? `\nFlags: ${confidence.flags.join(", ")}` : ""}${routingDecision ? `\nRouting: ${getRoutingLabel(routingDecision)}` : ""}`}
            >
              {Math.round(confidence.score * 100)}%
            </span>
          )}
          <span
            className={`rounded-md px-2 py-0.5 text-xs font-medium ${getPriorityBadgeColor(priority)}`}
          >
            <i className={`bi ${priority.toUpperCase() === "HIGH" ? "bi-arrow-up-circle-fill" : priority.toUpperCase() === "LOW" ? "bi-arrow-down-circle-fill" : "bi-dash-circle-fill"} mr-1`} />
            {priority}
          </span>
        </div>
      </div>
      <p className="line-clamp-2 text-sm text-stone-800 dark:text-stone-200">{description || "(no description)"}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-stone-200 dark:bg-stone-700 text-xs font-medium text-stone-600 dark:text-stone-300">
          {assignedTo.slice(-1).toUpperCase() || "?"}
        </span>
        <span className="text-xs text-stone-500 dark:text-stone-400">{assignedTo}</span>
        {isAutoApproved && (
          <span className="ml-auto rounded-md bg-emerald-100 dark:bg-emerald-900/50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            Auto
          </span>
        )}
      </div>
      {isPendingApproval && (
        <div className="mt-2" onPointerDown={(e) => e.stopPropagation()}>
          {!showFeedbackInput ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => sendCommand("task_approval_respond", { task_id: taskId, action: "approve" })}
                className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 transition-colors"
              >
                <i className="bi bi-check-lg mr-1" />Approve
              </button>
              <button
                type="button"
                onClick={() => setShowFeedbackInput(true)}
                className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700 transition-colors"
              >
                <i className="bi bi-x-lg mr-1" />Reject
              </button>
              <button
                type="button"
                onClick={() => sendCommand("task_approval_respond", { task_id: taskId, action: "escalate" })}
                className="rounded-md bg-stone-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-600 transition-colors"
              >
                <i className="bi bi-arrow-right-circle mr-1" />Defer
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Feedback required..."
                className="flex-1 rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-800 px-2 py-1 text-xs text-stone-800 dark:text-stone-200 placeholder-stone-400"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && feedbackText.trim()) {
                    sendCommand("task_approval_respond", { task_id: taskId, action: "reject", feedback: feedbackText.trim() });
                    setShowFeedbackInput(false);
                    setFeedbackText("");
                  }
                }}
              />
              <button
                type="button"
                disabled={!feedbackText.trim()}
                onClick={() => {
                  if (feedbackText.trim()) {
                    sendCommand("task_approval_respond", { task_id: taskId, action: "reject", feedback: feedbackText.trim() });
                    setShowFeedbackInput(false);
                    setFeedbackText("");
                  }
                }}
                className="rounded-md bg-rose-600 px-2 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50 transition-colors"
              >
                Send
              </button>
              <button
                type="button"
                onClick={() => { setShowFeedbackInput(false); setFeedbackText(""); }}
                className="rounded-md bg-stone-400 px-2 py-1 text-xs font-medium text-white hover:bg-stone-500 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {status === "in_progress" && remainingSeconds !== null && (
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-stone-500 dark:text-stone-400"><i className="bi bi-hourglass-split mr-1" />Timebox</span>
          <span
            className={`rounded-md px-1.5 py-0.5 text-xs font-mono ${
              isExpired ? "bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300" : "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300"
            }`}
          >
            {formatSeconds(remainingSeconds)}
          </span>
        </div>
      )}
      {status === "TIMEOUT_WARNING" && (
        <div className="mt-2 text-xs font-semibold text-rose-700 dark:text-rose-400">
          <i className="bi bi-alarm-fill mr-1" />Timebox exceeded - needs attention.
        </div>
      )}
      {reasoning && (
        <div className="mt-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowReasoning(!showReasoning); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            <i className={`bi ${showReasoning ? "bi-chevron-up" : "bi-chevron-down"}`} />
            {showReasoning ? "Hide" : "Show"} thinking ({reasoning.botId})
          </button>
          {showReasoning && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-stone-50 dark:bg-stone-900 p-2 text-xs text-stone-600 dark:text-stone-400 whitespace-pre-wrap">
              {reasoning.text}
            </pre>
          )}
        </div>
      )}
      {status === "in_progress" && streamingEntry && streamingEntry.text.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowStreaming(!showStreaming); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <i className={`bi ${showStreaming ? "bi-chevron-up" : "bi-chevron-down"}`} />
            {showStreaming ? "Hide" : "Show"} live output ({streamingEntry.botId})
          </button>
          {showStreaming && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-stone-50 dark:bg-stone-900 p-2 text-xs text-stone-600 dark:text-stone-400 whitespace-pre-wrap">
              {streamingEntry.text.slice(-500)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${mm}:${ss}`;
}
