import { useMemo } from "react";
import { useWsStore } from "../ws";
import type { NodeEventEntry } from "../ws/store";

const WORKFLOW_NODES = [
  "memory_retrieval",
  "sprint_planning",
  "system_design",
  "rfc_phase",
  "coordinator",
  "approval",
  "worker_execute",
  "human_approval",
  "increment_cycle",
];

const NODE_LABELS: Record<string, string> = {
  memory_retrieval: "Memory Retrieval",
  sprint_planning: "Sprint Planning",
  system_design: "System Design",
  rfc_phase: "RFC Phase",
  coordinator: "Coordinator",
  approval: "Approval",
  worker_execute: "Worker Execute",
  human_approval: "Human Approval",
  increment_cycle: "Increment Cycle",
};

const NODE_DESCRIPTIONS: Record<string, string> = {
  memory_retrieval: "Loading lessons from previous runs",
  sprint_planning: "Breaking goal into actionable tasks",
  system_design: "Designing system architecture",
  rfc_phase: "Reviewing and refining proposals",
  coordinator: "Assigning tasks to workers",
  approval: "Validating completed work",
  worker_execute: "Executing assigned tasks",
  human_approval: "Waiting for human review",
  increment_cycle: "Advancing to next cycle",
};

function summarizeNodeEvent(entry: NodeEventEntry): string {
  const { node, data } = entry;
  switch (node) {
    case "coordinator": {
      if (data.step) return String(data.detail || data.message);
      const pending = data.pending_count ?? data.tasks_pending;
      if (pending !== undefined) return `${pending} tasks pending`;
      if (data.message) return String(data.message);
      return "Coordinating tasks";
    }
    case "worker_execute": {
      const taskId = data.task_id ?? data.taskId ?? "";
      const status = data.status ?? data.result ?? "";
      const quality = data.quality_score ?? data.quality;
      let summary = taskId ? String(taskId) : "Task";
      if (status) summary += ` \u2014 ${status}`;
      if (quality !== undefined) summary += ` (quality: ${quality})`;
      return summary;
    }
    case "approval": {
      const decision = data.decision ?? data.status ?? data.result;
      if (decision) return `Approval: ${decision}`;
      return "Reviewing work";
    }
    case "increment_cycle": {
      const cycle = data.cycle ?? data.cycle_number;
      if (cycle !== undefined) return `Cycle ${cycle} completed`;
      return "Cycle completed";
    }
    default: {
      if (data.message) return String(data.message);
      if (data.status) return String(data.status);
      return NODE_DESCRIPTIONS[node] ?? "Processing";
    }
  }
}

function ProgressHeader() {
  const gen = useWsStore((s) => s.generationProgress);
  const cyc = useWsStore((s) => s.cycleProgress);

  if (!gen && !cyc) {
    return (
      <div className="px-3 py-2 text-xs text-stone-400 dark:text-stone-500">
        Waiting to start...
      </div>
    );
  }

  const parts: string[] = [];
  if (gen) parts.push(`Generation ${gen.generation}/${gen.maxGenerations}`);
  if (cyc) parts.push(`Cycle ${cyc.cycle}/${cyc.maxCycles}`);

  const genPct = gen ? (gen.generation / gen.maxGenerations) * 100 : 0;
  const cycPct = cyc ? (cyc.cycle / cyc.maxCycles) * 100 : 0;

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
          {parts.join(" \u00b7 ")}
        </span>
        {gen?.outcome && (
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
            gen.outcome === "success"
              ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
              : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
          }`}>
            {gen.outcome}
          </span>
        )}
      </div>
      <div className="flex gap-1 h-1 rounded-full overflow-hidden bg-stone-100 dark:bg-stone-800">
        {gen && (
          <div
            className="h-full bg-sky-500 dark:bg-sky-400 rounded-full transition-all duration-500"
            style={{ width: `${genPct}%` }}
          />
        )}
        {cyc && (
          <div
            className="h-full bg-amber-500 dark:bg-amber-400 rounded-full transition-all duration-500"
            style={{ width: `${cycPct}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function LiveStateGraph() {
  const activeNode = useWsStore((s) => s.activeNode);
  const completedNodes = useWsStore((s) => s.completedNodes);
  const nodeEventHistory = useWsStore((s) => s.nodeEventHistory);

  const eventsByNode = useMemo(() => {
    const map: Record<string, NodeEventEntry[]> = {};
    for (const entry of nodeEventHistory) {
      if (!map[entry.node]) map[entry.node] = [];
      map[entry.node].push(entry);
    }
    return map;
  }, [nodeEventHistory]);

  const recentEvents = useMemo(
    () => [...nodeEventHistory].reverse().slice(0, 15),
    [nodeEventHistory],
  );

  return (
    <div className="flex flex-col gap-0">
      {/* A. Progress header */}
      <ProgressHeader />

      {/* B. Workflow timeline */}
      <div className="flex-1 overflow-y-auto px-3 py-1">
        <div className="relative border-l-2 border-stone-200 dark:border-stone-700 ml-2">
          {WORKFLOW_NODES.map((node) => {
            const isActive = activeNode === node;
            const isCompleted = completedNodes.includes(node);
            const events = eventsByNode[node];
            const lastEvent = events?.[events.length - 1];
            const workerCount = node === "worker_execute" ? events?.length : undefined;

            return (
              <div
                key={node}
                className={`relative pl-5 py-2 animate-card-in ${
                  isActive ? "bg-amber-50/50 dark:bg-amber-900/10 rounded-r-lg" : ""
                }`}
              >
                {/* Timeline dot */}
                <div className={`absolute -left-[7px] top-3 w-3 h-3 rounded-full border-2 ${
                  isActive
                    ? "border-amber-400 bg-amber-400 animate-glow-pulse ring-1 ring-amber-400"
                    : isCompleted
                    ? "border-emerald-500 bg-emerald-500"
                    : "border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900"
                }`} />

                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-stone-700 dark:text-stone-200">
                        {NODE_LABELS[node] ?? node}
                      </span>
                      {isActive && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                          Active
                        </span>
                      )}
                      {isCompleted && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                          Done
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-stone-500 dark:text-stone-400 mt-0.5 truncate">
                      {lastEvent
                        ? (
                          <>
                            {workerCount && workerCount > 1
                              ? `${workerCount} tasks processed \u00b7 `
                              : ""}
                            {summarizeNodeEvent(lastEvent)}
                          </>
                        )
                        : NODE_DESCRIPTIONS[node] ?? ""}
                    </p>
                  </div>
                  {lastEvent?.timestamp && (
                    <span className="text-[10px] text-stone-400 dark:text-stone-500 whitespace-nowrap mt-0.5">
                      {lastEvent.timestamp}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* C. Activity feed */}
      {recentEvents.length > 0 && (
        <div className="border-t border-stone-200 dark:border-stone-700 px-3 py-2 max-h-[150px] overflow-y-auto">
          <h5 className="text-[10px] font-semibold text-stone-400 dark:text-stone-500 uppercase tracking-wider mb-1">
            Recent Activity
          </h5>
          <div className="flex flex-col gap-0.5">
            {recentEvents.map((entry, i) => {
              const isCompleted = completedNodes.includes(entry.node);
              const isActive = activeNode === entry.node;
              const dotColor = isActive
                ? "bg-amber-400"
                : isCompleted
                ? "bg-emerald-500"
                : "bg-stone-400";

              return (
                <div key={`${entry.receivedAt}-${i}`} className="flex items-start gap-1.5 text-[11px]">
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
                  <span className="text-stone-400 dark:text-stone-500 whitespace-nowrap">
                    {entry.timestamp || new Date(entry.receivedAt).toLocaleTimeString("en-GB", { hour12: false })}
                  </span>
                  <span className="text-stone-600 dark:text-stone-300 truncate">
                    {NODE_LABELS[entry.node] ?? entry.node} &mdash; {summarizeNodeEvent(entry)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
