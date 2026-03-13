import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import { useWsStore } from "../ws";
import { useTheme } from "../theme";

export function NodeGraphView() {
  const task_queue = useWsStore((s) => s.task_queue);
  const config = useWsStore((s) => s.config);
  const connectionStatus = useWsStore((s) => s.connectionStatus);
  const { isDark } = useTheme();
  const isLoading = connectionStatus === "connecting" || connectionStatus === "reconnecting";

  const goalLabel =
    (config?.saved_goal as string | undefined)?.trim() ||
    "User Goal";

  const { nodes, edges, bgColor } = useMemo(() => {
    const baseNodes: Node[] = [];
    const baseEdges: Edge[] = [];

    const goalStyle = isDark
      ? { borderRadius: 8, padding: 8, border: "1px solid #6b7280", background: "#1f2937", color: "#f9fafb", fontSize: 12 }
      : { borderRadius: 8, padding: 8, border: "1px solid #4b5563", background: "#111827", color: "#f9fafb", fontSize: 12 };

    baseNodes.push({
      id: "goal",
      position: { x: 0, y: 0 },
      data: { label: goalLabel },
      style: goalStyle,
    });

    const horizontalSpacing = 220;
    const verticalSpacing = 90;

    task_queue.forEach((task, index) => {
      const id = (task.task_id as string) ?? `task-${index}`;
      const description = (task.description as string) ?? "";
      const status = (task.status as string) ?? "pending";
      const priority = (task.priority as string) ?? "MEDIUM";
      const assignedTo = (task.assigned_to as string) ?? "";

      const col = index % 4;
      const row = Math.floor(index / 4);
      const x = (col - 1.5) * horizontalSpacing;
      const y = (row + 1) * verticalSpacing;

      baseNodes.push({
        id,
        position: { x, y },
        data: {
          label: (
            <div className="text-[10px] leading-tight">
              <div className="mb-0.5 flex items-center justify-between gap-1">
                <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400">{id}</span>
                <span className={`rounded px-1 py-0.5 text-[9px] ${priorityClass(priority)}`}>
                  {priority}
                </span>
              </div>
              <div className="line-clamp-2 text-[10px] text-gray-900 dark:text-gray-100">
                {description || "(no description)"}
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[9px] text-gray-500 dark:text-gray-400">
                <span>{assignedTo || "unassigned"}</span>
                <span className={`rounded px-1 py-0.5 ${statusClass(status)}`}>{status}</span>
              </div>
            </div>
          ),
        },
        style: {
          borderRadius: 8,
          padding: 6,
          border: borderColorForStatus(status, isDark),
          background: backgroundForStatus(status, isDark),
          minWidth: 160,
        },
      });

      const strokeColor = borderColorForStatus(status, isDark).replace(/^(\d+px )?solid /, "");
      baseEdges.push({
        id: `goal-${id}`,
        source: "goal",
        target: id,
        animated: status === "in_progress",
        style: { stroke: strokeColor, strokeWidth: 1.2 },
      });
    });

    const bg = isDark ? "#374151" : "#e5e7eb";
    return { nodes: baseNodes, edges: baseEdges, bgColor: bg };
  }, [task_queue, goalLabel, isDark]);

  if (isLoading && task_queue.length === 0) {
    return (
      <section className="flex h-full min-h-[220px] flex-col rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-2 shadow-sm transition-colors duration-200 ease-in-out">
        <header className="mb-2 flex items-baseline justify-between px-1">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Mind Map</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Visual relationship between the user goal and tasks.
            </p>
          </div>
        </header>
        <div className="flex-1 overflow-hidden rounded-md border border-gray-100 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50">
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 dark:border-gray-600 border-t-blue-500"></div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading tasks...</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-[220px] flex-col rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 p-2 shadow-sm transition-colors duration-200 ease-in-out">
      <header className="mb-2 flex items-baseline justify-between px-1">
        <div>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Mind Map</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Visual relationship between the user goal and tasks.
          </p>
        </div>
      </header>
      <div className="flex-1 overflow-hidden rounded-md border border-gray-100 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={12} size={1} color={bgColor} />
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  );
}

function priorityClass(priority: string): string {
  const p = (priority || "MEDIUM").toUpperCase();
  if (p === "HIGH") return "bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300";
  if (p === "LOW") return "bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-300";
  return "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300";
}

function statusClass(status: string): string {
  if (status === "completed") return "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300";
  if (status === "in_progress") return "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300";
  if (status === "failed") return "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300";
  if (status === "TIMEOUT_WARNING") return "bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300";
  if (status === "needs_approval") return "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300";
  return "bg-gray-100 dark:bg-gray-600 text-gray-600 dark:text-gray-300";
}

function borderColorForStatus(status: string, isDark: boolean): string {
  const light: Record<string, string> = {
    completed: "1px solid #10b981",
    in_progress: "1px solid #3b82f6",
    failed: "1px solid #ef4444",
    TIMEOUT_WARNING: "2px solid #dc2626",
    needs_approval: "1px solid #f97316",
  };
  const dark: Record<string, string> = {
    completed: "1px solid #34d399",
    in_progress: "1px solid #60a5fa",
    failed: "1px solid #f87171",
    TIMEOUT_WARNING: "2px solid #f87171",
    needs_approval: "1px solid #fb923c",
  };
  const map = isDark ? dark : light;
  return map[status] ?? (isDark ? "1px solid #4b5563" : "1px solid #e5e7eb");
}

function backgroundForStatus(status: string, isDark: boolean): string {
  const light: Record<string, string> = {
    completed: "#ecfdf5",
    in_progress: "#eff6ff",
    failed: "#fef2f2",
    TIMEOUT_WARNING: "#fef2f2",
    needs_approval: "#fffbeb",
  };
  const dark: Record<string, string> = {
    completed: "#064e3b",
    in_progress: "#1e3a8a",
    failed: "#7f1d1d",
    TIMEOUT_WARNING: "#7f1d1d",
    needs_approval: "#78350f",
  };
  const map = isDark ? dark : light;
  return map[status] ?? (isDark ? "#1f2937" : "#ffffff");
}

