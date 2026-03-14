import { useState } from "react";
import { useWsStore, type AlertType } from "../ws";

const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  approval_request: "Approvals",
  hallucination_warning: "Hallucinations",
  system_error: "System Errors",
  timeout: "Timeouts",
};

export function NotificationPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const alerts = useWsStore((s) => s.alerts);
  const pendingApproval = useWsStore((s) => s.pendingApproval);
  const removeAlert = useWsStore((s) => s.removeAlert);
  const markRead = useWsStore((s) => s.markRead);
  const markAllRead = useWsStore((s) => s.markAllRead);
  const clearAlerts = useWsStore((s) => s.clearAlerts);
  const setPendingApproval = useWsStore((s) => s.setPendingApproval);
  const sendMessage = useWsStore((s) => s.sendMessage);
  const notificationPrefs = useWsStore((s) => s.notificationPrefs);
  const setNotificationPrefs = useWsStore((s) => s.setNotificationPrefs);
  const toggleNotificationType = useWsStore((s) => s.toggleNotificationType);

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [prefsOpen, setPrefsOpen] = useState(false);

  const unreadCount = alerts.filter((a) => !a.read).length;

  function handleApprove() {
    sendMessage({ command: "approval_response", action: "approved" });
    setPendingApproval(null);
    setFeedbackOpen(false);
    setFeedbackText("");
  }

  function handleRejectSubmit() {
    const trimmed = feedbackText.trim();
    sendMessage({ command: "approval_response", action: "feedback", feedback: trimmed || undefined });
    setPendingApproval(null);
    setFeedbackOpen(false);
    setFeedbackText("");
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-20 animate-fade-in" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 z-30 w-80 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl animate-drop-in">
        <div className="flex items-center justify-between border-b border-stone-200 dark:border-stone-700 px-4 py-3">
          <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100"><i className="bi bi-bell-fill mr-1.5" />Notifications</h3>
          <div className="flex items-center gap-1.5">
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                title="Mark all read"
              >
                Mark all read
              </button>
            )}
            <button
              type="button"
              onClick={() => setPrefsOpen((v) => !v)}
              className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors p-0.5"
              title="Notification preferences"
            >
              <i className="bi bi-gear text-sm" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
            >
              ×
            </button>
          </div>
        </div>

        {prefsOpen && (
          <div className="border-b border-stone-200 dark:border-stone-700 px-4 py-2.5 space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-xs font-medium text-stone-700 dark:text-stone-300">Notifications enabled</span>
              <button
                type="button"
                onClick={() => setNotificationPrefs({ enabled: !notificationPrefs.enabled })}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${notificationPrefs.enabled ? "bg-blue-500" : "bg-stone-300 dark:bg-stone-600"}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${notificationPrefs.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </label>
            {notificationPrefs.enabled && (
              <div className="space-y-1 pl-1">
                {(Object.keys(ALERT_TYPE_LABELS) as AlertType[]).map((t) => (
                  <label key={t} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={notificationPrefs.types[t]}
                      onChange={() => toggleNotificationType(t)}
                      className="h-3.5 w-3.5 rounded border-stone-300 dark:border-stone-600 text-blue-500 focus:ring-blue-500"
                    />
                    <span className="text-xs text-stone-600 dark:text-stone-400">{ALERT_TYPE_LABELS[t]}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="max-h-96 overflow-y-auto p-3 space-y-2">
          {!notificationPrefs.enabled ? (
            <p className="py-4 text-center text-xs text-stone-400 dark:text-stone-500">Notifications paused. Enable in preferences above.</p>
          ) : (
            <>
              {pendingApproval && (
                <div className="rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 p-3 text-xs">
                  <div className="mb-1 font-semibold text-amber-800 dark:text-amber-300">Approval Required</div>
                  <p className="mb-2 text-xs text-amber-900 dark:text-amber-200">
                    {(pendingApproval.description as string) ?? "A task requires your approval."}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleApprove}
                      className="rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-600 transition-colors"
                    >
                      <i className="bi bi-check-lg mr-1" />Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => setFeedbackOpen((v) => !v)}
                      className="rounded-lg border border-amber-500 dark:border-amber-600 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-800/50 transition-colors"
                    >
                      <i className="bi bi-x-lg mr-1" />Reject
                    </button>
                  </div>
                  {feedbackOpen && (
                    <div className="mt-2 space-y-1.5">
                      <textarea
                        rows={3}
                        value={feedbackText}
                        onChange={(e) => setFeedbackText(e.target.value)}
                        className="w-full rounded-lg border border-amber-300 dark:border-amber-600 bg-white dark:bg-stone-800 p-2 text-xs text-amber-900 dark:text-amber-100 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 transition-[border-color,box-shadow] duration-150"
                        placeholder="Explain why you are rejecting..."
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => { setFeedbackOpen(false); setFeedbackText(""); }}
                          className="rounded-lg px-2 py-1 text-xs text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleRejectSubmit}
                          className="rounded-lg bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700 transition-colors"
                        >
                          Send Feedback
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {alerts.length === 0 && !pendingApproval ? (
                <p className="py-4 text-center text-xs text-stone-400 dark:text-stone-500">No notifications.</p>
              ) : (
                <>
                  {alerts
                    .slice()
                    .reverse()
                    .map((alert) => (
                      <div
                        key={alert.id}
                        onClick={() => { if (!alert.read) markRead(alert.id); }}
                        className={`flex items-start justify-between gap-2 rounded-lg border p-2.5 text-xs transition-colors cursor-pointer ${
                          alert.read
                            ? "border-stone-100 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-800/50 opacity-60"
                            : `border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 ${borderAccentForType(alert.type)}`
                        }`}
                      >
                        <div className="flex gap-2">
                          {!alert.read && (
                            <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColorForType(alert.type)}`} />
                          )}
                          <div>
                            <div className="mb-0.5 flex items-center gap-1.5">
                              <span className={badgeClassForType(alert.type)}><i className={`bi ${badgeIconForType(alert.type)} mr-1`} />{badgeLabelForType(alert.type)}</span>
                              <span className="text-xs text-stone-400 dark:text-stone-500">
                                {new Date(alert.created_at).toLocaleTimeString()}
                              </span>
                            </div>
                            <div className="text-stone-800 dark:text-stone-200">{alert.message}</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeAlert(alert.id); }}
                          className="text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 transition-colors"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  {alerts.length > 5 && (
                    <button
                      type="button"
                      onClick={clearAlerts}
                      className="w-full text-center text-xs text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 py-1 transition-colors"
                    >
                      Clear all
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function borderAccentForType(type: AlertType): string {
  if (type === "approval_request") return "border-l-2 border-l-amber-400 dark:border-l-amber-500";
  if (type === "hallucination_warning") return "border-l-2 border-l-orange-400 dark:border-l-orange-500";
  if (type === "timeout") return "border-l-2 border-l-violet-400 dark:border-l-violet-500";
  return "border-l-2 border-l-red-400 dark:border-l-red-500";
}

function dotColorForType(type: AlertType): string {
  if (type === "approval_request") return "bg-amber-500";
  if (type === "hallucination_warning") return "bg-orange-500";
  if (type === "timeout") return "bg-violet-500";
  return "bg-red-500";
}

function badgeClassForType(type: AlertType): string {
  if (type === "approval_request") {
    return "inline-flex items-center rounded-md bg-amber-100 dark:bg-amber-900/50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300";
  }
  if (type === "hallucination_warning") {
    return "inline-flex items-center rounded-md bg-orange-100 dark:bg-orange-900/50 px-2 py-0.5 text-xs font-medium text-orange-800 dark:text-orange-300";
  }
  if (type === "timeout") {
    return "inline-flex items-center rounded-md bg-violet-100 dark:bg-violet-900/50 px-2 py-0.5 text-xs font-medium text-violet-800 dark:text-violet-300";
  }
  return "inline-flex items-center rounded-md bg-red-100 dark:bg-red-900/50 px-2 py-0.5 text-xs font-medium text-red-800 dark:text-red-300";
}

function badgeIconForType(type: AlertType): string {
  if (type === "approval_request") return "bi-shield-check";
  if (type === "hallucination_warning") return "bi-exclamation-diamond";
  if (type === "timeout") return "bi-hourglass-split";
  return "bi-exclamation-octagon";
}

function badgeLabelForType(type: AlertType): string {
  if (type === "approval_request") return "Approval";
  if (type === "hallucination_warning") return "Hallucination";
  if (type === "timeout") return "Timeout";
  return "System";
}
