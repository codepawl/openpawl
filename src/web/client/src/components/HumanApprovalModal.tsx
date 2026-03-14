import { useWsStore } from "../ws";

export function HumanApprovalModal() {
  const pending = useWsStore((s) => s.pendingApproval);
  const sendMessage = useWsStore((s) => s.sendMessage);
  const setPendingApproval = useWsStore((s) => s.setPendingApproval);

  if (!pending) return null;

  const taskId = (pending.task_id as string) ?? "unknown";
  const description = (pending.description as string) ?? "";

  const respond = (action: "approve" | "reject" | "feedback", feedback?: string) => {
    sendMessage?.({
      command: "approval_response",
      task_id: taskId,
      action,
      feedback: feedback ?? "",
    });
    setPendingApproval(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="mx-4 w-full max-w-lg rounded-2xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-6 shadow-xl animate-zoom-in">
        <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100 mb-2">
          <i className="bi bi-shield-exclamation mr-1.5" />Approval Required
        </h3>
        <p className="text-sm text-stone-500 dark:text-stone-400 mb-1">Task: {taskId}</p>
        <p className="text-sm text-stone-700 dark:text-stone-300 mb-4">{description}</p>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => respond("reject")}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-rose-500 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
          >
            <i className="bi bi-x-circle mr-1" />Reject
          </button>
          <button
            type="button"
            onClick={() => respond("approve")}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 transition-colors"
          >
            <i className="bi bi-check-circle mr-1" />Approve
          </button>
        </div>
      </div>
    </div>
  );
}
