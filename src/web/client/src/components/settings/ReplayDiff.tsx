import { useWsStore } from "../../ws";

export function ReplayDiff() {
  const nodeEventHistory = useWsStore((s) => s.nodeEventHistory);

  // Show patched events with visual diff highlighting
  const patchedEvents = nodeEventHistory.filter(
    (e) => (e.data as Record<string, unknown>)?.patched === true,
  );

  if (patchedEvents.length === 0) return null;

  return (
    <div className="space-y-3 border-t border-stone-200 dark:border-stone-700 pt-3">
      <h4 className="text-xs font-semibold text-amber-600 dark:text-amber-400">
        <i className="bi bi-diff mr-1" />
        Patched Nodes
      </h4>

      {patchedEvents.map((event, i) => (
        <div
          key={i}
          className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 p-2 space-y-1"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
              {event.node}
            </span>
            <span className="text-xs text-amber-500">{event.timestamp}</span>
          </div>
          <p className="text-xs text-stone-600 dark:text-stone-400 whitespace-pre-wrap">
            {(event.data as Record<string, unknown>)?.output as string ?? "—"}
          </p>
        </div>
      ))}
    </div>
  );
}
