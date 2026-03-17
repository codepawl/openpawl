import type { CoordinatorInterventionResult } from "./types.js";
import { getPersonality } from "./profiles.js";

interface GraphStateLike {
  confidence_history?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export function detectCoordinatorIntervention(
  state: GraphStateLike,
): CoordinatorInterventionResult | null {
  const history = state.confidence_history;
  if (!history || history.length === 0) return null;

  // Count rework cycles per task
  const reworkCounts = new Map<string, number>();
  for (const entry of history) {
    const taskId = String(entry.task_id ?? "");
    const statusBefore = String(entry.status_before ?? "");
    const statusAfter = String(entry.status_after ?? "");
    if (statusBefore === "needs_rework" || statusAfter === "needs_rework") {
      reworkCounts.set(taskId, (reworkCounts.get(taskId) ?? 0) + 1);
    }
  }

  // Find tasks with > 2 rework cycles
  for (const [taskId, count] of reworkCounts) {
    if (count > 2) {
      const coordinator = getPersonality("coordinator");
      const catchphrase = coordinator.catchphrases[0] ?? "Decision time.";

      return {
        message: `Round ${count} on task ${taskId}. ${catchphrase} Accepting current output at reduced confidence. This is blocking the sprint — deciding now. We can revisit in retrospective.`,
        taskId,
        visitCount: count,
      };
    }
  }

  return null;
}
