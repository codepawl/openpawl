/**
 * Periodic task timeout checker for active orchestration threads.
 */

import { createTeamOrchestration } from "../core/simulation.js";
import { broadcast } from "./session-state.js";

export type ThreadRegistryEntry = {
  orch: ReturnType<typeof createTeamOrchestration>;
};

export const THREAD_REGISTRY = new Map<string, ThreadRegistryEntry>();

let timeoutCheckerStarted = false;

export function startTimeoutChecker(): void {
  if (timeoutCheckerStarted) return;
  timeoutCheckerStarted = true;
  const intervalMs = 10000;
  setInterval(async () => {
    if (THREAD_REGISTRY.size === 0) return;
    for (const [threadId, entry] of THREAD_REGISTRY.entries()) {
      try {
        const config = { configurable: { thread_id: threadId } };
        const snapshot = await entry.orch.graph.getState(config);
        const values = (snapshot as { values?: Record<string, unknown> }).values ?? {};
        const taskQueue = (values.task_queue ?? []) as Record<string, unknown>[];
        if (!Array.isArray(taskQueue) || taskQueue.length === 0) continue;

        const now = Date.now();
        let updated = false;
        const updatedQueue = taskQueue.map((task) => {
          const status = task.status as string | undefined;
          if (status !== "in_progress") return task;
          const startedAtRaw = task.in_progress_at as string | null | undefined;
          const startedAtMs =
            typeof startedAtRaw === "string" && startedAtRaw
              ? Date.parse(startedAtRaw)
              : Number.NaN;
          const rawTimebox = Number(task.timebox_minutes ?? 25);
          const timeboxMinutes =
            Number.isFinite(rawTimebox) && rawTimebox >= 1 ? rawTimebox : 25;
          if (!Number.isFinite(startedAtMs)) return task;
          const limitMs = timeboxMinutes * 60_000;
          const elapsedMs = now - startedAtMs;
          if (elapsedMs >= limitMs && (task.status as string) !== "TIMEOUT_WARNING") {
            updated = true;
            return {
              ...task,
              status: "TIMEOUT_WARNING",
            };
          }
          return task;
        });

        if (!updated) continue;

        await entry.orch.graph.updateState(config, { task_queue: updatedQueue });
        broadcast({
          type: "task_queue_updated",
          task_queue: updatedQueue,
        });
        for (const task of updatedQueue) {
          if ((task.status as string) === "TIMEOUT_WARNING") {
            broadcast({
              type: "timeout_alert",
              task_queue: updatedQueue,
              task_id: task.task_id as string,
            });
          }
        }
      } catch {
        // Best-effort timeout checking; ignore errors.
      }
    }
  }, intervalMs);
}
