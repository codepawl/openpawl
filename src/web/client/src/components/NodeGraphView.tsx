import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import { useWsStore } from "../ws";
import { useTheme } from "../theme";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

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
      ? { borderRadius: 8, padding: 8, border: "1px solid #78716c", background: "#292524", color: "#fafaf9", fontSize: 12 }
      : { borderRadius: 8, padding: 8, border: "1px solid #78716c", background: "#1c1917", color: "#fafaf9", fontSize: 12 };

    // Group tasks by assigned_to
    const groups = new Map<string, Array<{ task: Record<string, unknown>; index: number }>>();
    task_queue.forEach((task, index) => {
      const assignee = (task.assigned_to as string) || "unassigned";
      if (!groups.has(assignee)) groups.set(assignee, []);
      groups.get(assignee)!.push({ task, index });
    });

    const assignees = Array.from(groups.keys());
    const colWidth = 240;
    const rowHeight = 120;

    // Goal node centered at top
    baseNodes.push({
      id: "goal",
      position: { x: ((assignees.length - 1) * colWidth) / 2, y: 0 },
      data: { label: truncate(goalLabel, 60) },
      style: goalStyle,
    });

    const arrowMarker = { type: MarkerType.ArrowClosed as const, width: 14, height: 14 };

    // Lay out tasks in columns by assignee
    assignees.forEach((assignee, colIdx) => {
      const tasks = groups.get(assignee)!;
      tasks.forEach((item, rowIdx) => {
        const id = (item.task.task_id as string) ?? `task-${item.index}`;
        const description = (item.task.description as string) ?? "";
        const status = (item.task.status as string) ?? "pending";
        const priority = (item.task.priority as string) ?? "MEDIUM";
        const stepNum = item.index + 1;

        const x = colIdx * colWidth;
        const y = (rowIdx + 1) * rowHeight;

        baseNodes.push({
          id,
          position: { x, y },
          data: {
            label: (
              <div className="text-xs leading-tight">
                <div className="mb-0.5 flex items-center justify-between gap-1">
                  <span className="font-mono text-xs text-stone-500 dark:text-stone-400">#{stepNum} {id}</span>
                  <span className={`rounded-md px-1 py-0.5 text-xs ${priorityClass(priority)}`}>
                    {priority}
                  </span>
                </div>
                <div className="line-clamp-2 text-xs text-stone-900 dark:text-stone-100">
                  {truncate(description || "(no description)", 60)}
                </div>
                <div className="mt-0.5 flex items-center justify-between text-xs text-stone-500 dark:text-stone-400">
                  <span>{assignee}</span>
                  <span className={`rounded-md px-1 py-0.5 ${statusClass(status)}`}>{status}</span>
                </div>
              </div>
            ),
          },
          style: {
            borderRadius: 12,
            padding: 6,
            border: borderColorForStatus(status, isDark),
            background: backgroundForStatus(status, isDark),
            minWidth: 200,
          },
        });

        const strokeColor = borderColorForStatus(status, isDark).replace(/^(\d+px )?solid /, "");

        if (rowIdx === 0) {
          // First task in column connects to goal
          baseEdges.push({
            id: `goal-${id}`,
            source: "goal",
            target: id,
            animated: status === "in_progress",
            style: { stroke: strokeColor, strokeWidth: 1.2 },
            markerEnd: arrowMarker,
          });
        } else {
          // Chain to previous task in same column
          const prevId = (tasks[rowIdx - 1].task.task_id as string) ?? `task-${tasks[rowIdx - 1].index}`;
          baseEdges.push({
            id: `${prevId}-${id}`,
            source: prevId,
            target: id,
            animated: status === "in_progress",
            style: { stroke: strokeColor, strokeWidth: 1.2 },
            markerEnd: arrowMarker,
          });
        }
      });
    });

    const bg = isDark ? "#44403c" : "#d6d3d1";
    return { nodes: baseNodes, edges: baseEdges, bgColor: bg };
  }, [task_queue, goalLabel, isDark]);

  if (isLoading && task_queue.length === 0) {
    return (
      <section className="flex h-full min-h-[220px] flex-col">
        <div className="flex-1 overflow-hidden rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800">
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-stone-200 dark:border-stone-700 border-t-sky-500"></div>
              <p className="text-sm text-stone-500 dark:text-stone-400">Loading tasks...</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-[220px] flex-col">
      <div className="flex-1 overflow-hidden rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={12} size={1} color={bgColor} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  );
}

function priorityClass(priority: string): string {
  const p = (priority || "MEDIUM").toUpperCase();
  if (p === "HIGH") return "bg-rose-100 dark:bg-rose-900/50 text-rose-800 dark:text-rose-300";
  if (p === "LOW") return "bg-stone-100 dark:bg-stone-700 text-stone-700 dark:text-stone-300";
  return "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300";
}

function statusClass(status: string): string {
  if (status === "completed") return "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300";
  if (status === "in_progress") return "bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300";
  if (status === "failed") return "bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300";
  if (status === "TIMEOUT_WARNING") return "bg-rose-100 dark:bg-rose-900/50 text-rose-800 dark:text-rose-300";
  if (status === "needs_approval") return "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300";
  return "bg-stone-100 dark:bg-stone-700 text-stone-600 dark:text-stone-300";
}

function borderColorForStatus(status: string, isDark: boolean): string {
  const light: Record<string, string> = {
    completed: "1px solid #10b981",
    in_progress: "1px solid #0ea5e9",
    failed: "1px solid #f43f5e",
    TIMEOUT_WARNING: "2px solid #e11d48",
    needs_approval: "1px solid #f97316",
  };
  const dark: Record<string, string> = {
    completed: "1px solid #34d399",
    in_progress: "1px solid #38bdf8",
    failed: "1px solid #fb7185",
    TIMEOUT_WARNING: "2px solid #fb7185",
    needs_approval: "1px solid #fb923c",
  };
  const map = isDark ? dark : light;
  return map[status] ?? (isDark ? "1px solid #78716c" : "1px solid #d6d3d1");
}

function backgroundForStatus(status: string, isDark: boolean): string {
  const light: Record<string, string> = {
    completed: "#ecfdf5",
    in_progress: "#f0f9ff",
    failed: "#fff1f2",
    TIMEOUT_WARNING: "#fff1f2",
    needs_approval: "#fffbeb",
  };
  const dark: Record<string, string> = {
    completed: "#064e3b",
    in_progress: "#0c4a6e",
    failed: "#881337",
    TIMEOUT_WARNING: "#881337",
    needs_approval: "#78350f",
  };
  const map = isDark ? dark : light;
  return map[status] ?? (isDark ? "#292524" : "#ffffff");
}
