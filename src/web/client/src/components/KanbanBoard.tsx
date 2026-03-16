import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { useWsStore } from "../ws";
import { KanbanColumn } from "./KanbanColumn";

const COLUMNS: { id: string; title: string; statuses: string[] }[] = [
  { id: "backlog", title: "Backlog", statuses: ["backlog"] },
  { id: "todo", title: "To Do", statuses: ["pending"] },
  { id: "in_progress", title: "In Progress", statuses: ["in_progress", "reviewing", "needs_rework", "rfc_pending"] },
  {
    id: "needs_approval",
    title: "Needs Approval",
    statuses: ["needs_approval", "waiting_for_human", "auto_approved_pending", "TIMEOUT_WARNING"],
  },
  { id: "done", title: "Done", statuses: ["completed", "failed"] },
  { id: "deferred", title: "Deferred", statuses: ["escalated"] },
];

const COLUMN_ID_TO_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "pending",
  in_progress: "in_progress",
  needs_approval: "needs_approval",
  done: "completed",
  deferred: "escalated",
};

function statusToColumnId(status: string): string {
  for (const col of COLUMNS) {
    if (col.statuses.includes(status)) return col.id;
  }
  return "backlog";
}

export function KanbanBoard() {
  const task_queue = useWsStore((s) => s.task_queue);
  const connectionStatus = useWsStore((s) => s.connectionStatus);
  const sendCommand = useWsStore((s) => s.sendCommand);
  const isLoading = connectionStatus === "connecting" || connectionStatus === "reconnecting";

  const tasksByColumn = COLUMNS.map((col) => ({
    ...col,
    tasks: task_queue.filter((t) => {
      const s = (t.status as string) ?? "pending";
      return col.statuses.includes(s);
    }),
  }));

  if (isLoading && task_queue.length === 0) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-4">
        {COLUMNS.map((col) => (
          <div
            key={col.id}
            className="min-w-[260px] flex-1 rounded-xl bg-stone-100 dark:bg-stone-800 p-3 animate-pulse"
          >
            <div className="h-5 w-24 bg-stone-300 dark:bg-stone-700 rounded-lg mb-3"></div>
            <div className="space-y-2">
              <div className="h-16 bg-stone-200 dark:bg-stone-700 rounded-xl"></div>
              <div className="h-16 bg-stone-200 dark:bg-stone-700 rounded-xl"></div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const taskId = active.id as string;
    let targetColumnId = over.id as string;
    if (COLUMN_ID_TO_STATUS[targetColumnId] === undefined) {
      const overTask = task_queue.find((t) => (t.task_id as string) === targetColumnId);
      targetColumnId = overTask ? statusToColumnId((overTask.status as string) ?? "pending") : "todo";
    }
    const newStatus = COLUMN_ID_TO_STATUS[targetColumnId];
    if (!newStatus) return;

    const task = task_queue.find((t) => (t.task_id as string) === taskId);
    if (!task) return;

    const updates: Record<string, string> = { status: newStatus };
    if (targetColumnId === "todo") {
      updates.priority = "HIGH";
    }

    sendCommand("update_task", {
      taskId,
      updates,
    });
  }

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {tasksByColumn.map((col) => (
          <KanbanColumn
            key={col.id}
            id={col.id}
            title={col.title}
            tasks={col.tasks}
          />
        ))}
      </div>
    </DndContext>
  );
}
