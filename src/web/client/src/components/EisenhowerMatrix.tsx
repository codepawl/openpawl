import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent, useDroppable } from "@dnd-kit/core";
import { useState } from "react";
import { useWsStore } from "../ws";
import { TaskCard } from "./TaskCard";

type QuadrantId =
  | "urgent_important"
  | "not_urgent_important"
  | "urgent_not_important"
  | "not_urgent_not_important";

// -- Constants ----------------------------------------------------------------

const ACTIVE_STATUSES = ["pending", "backlog", "in_progress", "needs_approval", "waiting_for_human"];

interface QuadrantConfig {
  title: string;
  subtitle: string;
  emptyMessage: string;
  bg: string;
  bgOver: string;
  border: string;
  borderOver: string;
  stripe: string;
  countBg: string;
  icon: string;
}

const QUADRANT_CONFIG: Record<QuadrantId, QuadrantConfig> = {
  urgent_important: {
    title: "Do First",
    subtitle: "Urgent & Important",
    emptyMessage: "No critical tasks — nice!",
    bg: "bg-rose-50/60 dark:bg-rose-900/20",
    bgOver: "bg-rose-100/80 dark:bg-rose-900/30",
    border: "border-rose-300 dark:border-rose-700",
    borderOver: "border-rose-400 dark:border-rose-500",
    stripe: "bg-rose-400 dark:bg-rose-600",
    countBg: "bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300",
    icon: "bi-exclamation-triangle-fill text-rose-500 dark:text-rose-400",
  },
  not_urgent_important: {
    title: "Schedule",
    subtitle: "Not Urgent, Important",
    emptyMessage: "Nothing planned ahead",
    bg: "bg-sky-50/60 dark:bg-sky-900/20",
    bgOver: "bg-sky-100/80 dark:bg-sky-900/30",
    border: "border-sky-300 dark:border-sky-700",
    borderOver: "border-sky-400 dark:border-sky-500",
    stripe: "bg-sky-400 dark:bg-sky-600",
    countBg: "bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300",
    icon: "bi-calendar-event-fill text-sky-500 dark:text-sky-400",
  },
  urgent_not_important: {
    title: "Delegate",
    subtitle: "Urgent, Not Important",
    emptyMessage: "Nothing to hand off",
    bg: "bg-amber-50/60 dark:bg-amber-900/20",
    bgOver: "bg-amber-100/80 dark:bg-amber-900/30",
    border: "border-amber-300 dark:border-amber-700",
    borderOver: "border-amber-400 dark:border-amber-500",
    stripe: "bg-amber-400 dark:bg-amber-600",
    countBg: "bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300",
    icon: "bi-people-fill text-amber-500 dark:text-amber-400",
  },
  not_urgent_not_important: {
    title: "Eliminate",
    subtitle: "Not Urgent, Not Important",
    emptyMessage: "No low-priority items",
    bg: "bg-stone-100/60 dark:bg-stone-800/60",
    bgOver: "bg-stone-200/80 dark:bg-stone-800/80",
    border: "border-stone-300 dark:border-stone-700",
    borderOver: "border-stone-400 dark:border-stone-500",
    stripe: "bg-stone-400 dark:bg-stone-600",
    countBg: "bg-stone-200 dark:bg-stone-700 text-stone-600 dark:text-stone-300",
    icon: "bi-trash3-fill text-stone-400 dark:text-stone-500",
  },
};

type StatusFilter = "all" | "pending" | "in_progress" | "needs_action";

const STATUS_FILTERS: { key: StatusFilter; label: string; statuses: string[] }[] = [
  { key: "all", label: "All Active", statuses: ACTIVE_STATUSES },
  { key: "pending", label: "Pending", statuses: ["pending", "backlog"] },
  { key: "in_progress", label: "In Progress", statuses: ["in_progress"] },
  { key: "needs_action", label: "Needs Action", statuses: ["needs_approval", "waiting_for_human"] },
];

// -- Helpers ------------------------------------------------------------------

function getQuadrantForTask(task: Record<string, unknown>): QuadrantId {
  const rawUrgency = Number(task.urgency ?? 5);
  const rawImportance = Number(task.importance ?? 5);
  const urgency = Number.isFinite(rawUrgency) ? rawUrgency : 5;
  const importance = Number.isFinite(rawImportance) ? rawImportance : 5;
  const urgent = urgency >= 6;
  const important = importance >= 6;
  if (urgent && important) return "urgent_important";
  if (!urgent && important) return "not_urgent_important";
  if (urgent && !important) return "urgent_not_important";
  return "not_urgent_not_important";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const QUADRANT_RANGES: Record<QuadrantId, { urgency: [number, number]; importance: [number, number] }> = {
  urgent_important: { urgency: [7, 10], importance: [7, 10] },
  not_urgent_important: { urgency: [1, 5], importance: [7, 10] },
  urgent_not_important: { urgency: [7, 10], importance: [1, 5] },
  not_urgent_not_important: { urgency: [1, 5], importance: [1, 5] },
};

function getNudgedScores(
  quadrantId: QuadrantId,
  currentUrgency: number,
  currentImportance: number,
): { urgency: number; importance: number } {
  const range = QUADRANT_RANGES[quadrantId];
  return {
    urgency: clamp(currentUrgency, range.urgency[0], range.urgency[1]),
    importance: clamp(currentImportance, range.importance[0], range.importance[1]),
  };
}

// -- Components ---------------------------------------------------------------

function StatusFilterBar({
  active,
  onChange,
}: {
  active: StatusFilter;
  onChange: (f: StatusFilter) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {STATUS_FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => onChange(f.key)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            active === f.key
              ? "bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-900"
              : "bg-stone-100 dark:bg-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-600"
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

function MatrixQuadrant({
  id,
  config,
  tasks,
}: {
  id: QuadrantId;
  config: QuadrantConfig;
  tasks: Record<string, unknown>[];
}) {
  const { isOver, setNodeRef } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-[220px] flex-1 flex-col rounded-xl border-2 p-3 transition-all duration-200 ${
        isOver
          ? `${config.bgOver} ${config.borderOver} scale-[1.01]`
          : `${config.bg} ${config.border}`
      }`}
    >
      {/* Header with color stripe */}
      <div className="mb-2.5 flex items-start gap-2">
        <div className={`mt-0.5 h-9 w-1 flex-shrink-0 rounded-full ${config.stripe}`} />
        <div className="flex flex-1 items-baseline justify-between gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-stone-700 dark:text-stone-200">
              <i className={`bi ${config.icon} text-xs`} />
              {config.title}
            </div>
            <div className="text-xs text-stone-500 dark:text-stone-400">{config.subtitle}</div>
          </div>
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${config.countBg}`}>
            {tasks.length}
          </span>
        </div>
      </div>

      {/* Task list */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-6">
            <i className={`bi ${config.icon} text-lg opacity-30`} />
            <span className="text-xs text-stone-400 dark:text-stone-500">{config.emptyMessage}</span>
          </div>
        ) : (
          tasks.map((t) => {
            const r = t.result as Record<string, unknown> | null;
            const conf = r?.confidence as { score: number } | undefined;
            const confidenceScore = conf?.score;
            let ringClass = "";
            if (typeof confidenceScore === "number") {
              if (confidenceScore < 0.4) ringClass = "ring-2 ring-rose-500 dark:ring-rose-400";
              else if (confidenceScore < 0.6) ringClass = "ring-2 ring-orange-400 dark:ring-orange-400";
            }
            return (
              <div key={(t.task_id as string) ?? Math.random()} className={`rounded-xl ${ringClass}`}>
                <TaskCard task={t} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// -- Main Component -----------------------------------------------------------

export function EisenhowerMatrix() {
  const task_queue = useWsStore((s) => s.task_queue);
  const sendCommand = useWsStore((s) => s.sendCommand);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeTask, setActiveTask] = useState<Record<string, unknown> | null>(null);

  const allowedStatuses = STATUS_FILTERS.find((f) => f.key === statusFilter)?.statuses ?? ACTIVE_STATUSES;

  const matrixTasks = task_queue.filter((t) => {
    const status = (t.status as string) ?? "pending";
    return allowedStatuses.includes(status);
  });

  const tasksByQuadrant: Record<QuadrantId, Record<string, unknown>[]> = {
    urgent_important: [],
    urgent_not_important: [],
    not_urgent_important: [],
    not_urgent_not_important: [],
  };

  for (const task of matrixTasks) {
    const q = getQuadrantForTask(task);
    tasksByQuadrant[q].push(task);
  }

  function handleDragStart(event: DragStartEvent) {
    const task = matrixTasks.find((t) => (t.task_id as string) === event.active.id);
    setActiveTask(task ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;
    const taskId = active.id as string;
    const quadrantId = over.id as QuadrantId;
    if (!quadrantId || !QUADRANT_RANGES[quadrantId]) return;

    const task = matrixTasks.find((t) => (t.task_id as string) === taskId);
    if (!task) return;

    const currentQuadrant = getQuadrantForTask(task);
    if (currentQuadrant === quadrantId) return; // already in correct quadrant

    const currentUrgency = Number(task.urgency ?? 5);
    const currentImportance = Number(task.importance ?? 5);
    const scores = getNudgedScores(quadrantId, currentUrgency, currentImportance);

    sendCommand("update_task", {
      taskId,
      updates: {
        urgency: scores.urgency,
        importance: scores.importance,
      },
    });
  }

  function handleDragCancel() {
    setActiveTask(null);
  }

  return (
    <section>
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-semibold text-stone-700 dark:text-stone-200">Eisenhower Matrix</h2>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Drag tasks between quadrants to adjust urgency and importance.
          </p>
        </div>
      </header>

      <StatusFilterBar active={statusFilter} onChange={setStatusFilter} />

      <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
        {/* Axis labels */}
        <div className="mb-1.5 flex items-end pl-6">
          <span className="text-xs font-medium text-stone-400 dark:text-stone-500">
            ← Not Urgent
          </span>
          <span className="ml-auto text-xs font-medium text-stone-400 dark:text-stone-500">
            Urgent →
          </span>
        </div>

        <div className="flex gap-1">
          {/* Vertical axis label */}
          <div className="flex flex-col items-center justify-center">
            <span
              className="text-xs font-medium text-stone-400 dark:text-stone-500"
              style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
            >
              Important ↑ — Not Important ↓
            </span>
          </div>

          {/* 2x2 grid — layout: top-left=not_urgent_important, top-right=urgent_important */}
          <div className="grid flex-1 grid-cols-2 gap-3">
            <MatrixQuadrant
              id="not_urgent_important"
              config={QUADRANT_CONFIG.not_urgent_important}
              tasks={tasksByQuadrant.not_urgent_important}
            />
            <MatrixQuadrant
              id="urgent_important"
              config={QUADRANT_CONFIG.urgent_important}
              tasks={tasksByQuadrant.urgent_important}
            />
            <MatrixQuadrant
              id="not_urgent_not_important"
              config={QUADRANT_CONFIG.not_urgent_not_important}
              tasks={tasksByQuadrant.not_urgent_not_important}
            />
            <MatrixQuadrant
              id="urgent_not_important"
              config={QUADRANT_CONFIG.urgent_not_important}
              tasks={tasksByQuadrant.urgent_not_important}
            />
          </div>
        </div>

        {/* Drag overlay ghost card */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <div className="pointer-events-none w-[280px] opacity-80">
              <TaskCard task={activeTask} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </section>
  );
}
