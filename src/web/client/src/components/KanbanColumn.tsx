import { useDroppable } from "@dnd-kit/core";
import { TaskCard } from "./TaskCard";

const COLUMN_ICONS: Record<string, string> = {
  backlog: "bi-inbox",
  todo: "bi-card-checklist",
  in_progress: "bi-play-circle-fill",
  needs_approval: "bi-shield-check",
  done: "bi-check2-all",
};

export interface KanbanColumnProps {
  id: string;
  title: string;
  tasks: Record<string, unknown>[];
}

export function KanbanColumn({ id, title, tasks }: KanbanColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`flex min-w-[260px] flex-1 flex-col rounded-xl border-2 bg-stone-50 dark:bg-stone-900 p-3 transition-all duration-200 hover:-translate-y-0.5 ${
        isOver
          ? "border-sky-400 dark:border-sky-500 bg-sky-50/50 dark:bg-sky-900/20"
          : "border-stone-200 dark:border-stone-700"
      }`}
    >
      <h3 className="mb-3 text-sm font-semibold text-stone-700 dark:text-stone-200">
        <i className={`bi ${COLUMN_ICONS[id] ?? "bi-kanban"} mr-1.5`} />{title}
        <span className="ml-1.5 rounded-md bg-stone-200 dark:bg-stone-700 px-2 py-0.5 text-xs">
          {tasks.length}
        </span>
      </h3>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {tasks.length === 0 ? (
          <p className="py-4 text-center text-xs text-stone-400 dark:text-stone-500">No tasks</p>
        ) : (
          tasks.map((task) => (
            <TaskCard key={(task.task_id as string) ?? Math.random()} task={task} />
          ))
        )}
      </div>
    </div>
  );
}
