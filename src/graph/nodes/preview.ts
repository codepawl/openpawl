/**
 * Preview Node — pauses the graph after coordinator decomposition so the user
 * can approve, edit, or abort the task breakdown before execution begins.
 */

import type { GraphState } from "../../core/graph-state.js";
import type {
  PreviewTask,
  PreviewState,
  PreviewResponse,
  PreviewProvider,
  CostEstimate,
} from "../preview/types.js";
import { estimateCost, type CostConfig } from "../preview/estimator.js";
import { renderPreviewTable, promptPreviewAction } from "../../cli/preview.js";
import { logger, isDebugMode } from "../../core/logger.js";

function log(msg: string): void {
  if (isDebugMode()) {
    logger.agent(msg);
  }
}

/**
 * Extract typed PreviewTask[] from the raw task_queue records.
 */
function extractPreviewTasks(
  taskQueue: Record<string, unknown>[],
): PreviewTask[] {
  return taskQueue
    .filter((t) => (t.status as string) === "pending" || (t.status as string) === "rfc_pending")
    .map((t) => ({
      task_id: (t.task_id as string) ?? "",
      description: (t.description as string) ?? "",
      assigned_to: (t.assigned_to as string) ?? "",
      complexity: (t.complexity as string) ?? "MEDIUM",
      dependencies: (t.dependencies as string[]) ?? [],
    }));
}

/**
 * Apply edited tasks back to the full task queue.
 * Keeps non-pending tasks intact, replaces pending tasks with the edited list.
 */
function applyEdits(
  taskQueue: Record<string, unknown>[],
  editedTasks: PreviewTask[],
): Record<string, unknown>[] {
  const pendingIds = new Set(
    taskQueue
      .filter((t) => (t.status as string) === "pending" || (t.status as string) === "rfc_pending")
      .map((t) => t.task_id as string),
  );

  // Keep non-pending tasks
  const result = taskQueue.filter(
    (t) => !pendingIds.has(t.task_id as string),
  );

  // Add edited tasks (those that survived the edit)
  for (const edited of editedTasks) {
    const original = taskQueue.find((t) => t.task_id === edited.task_id);
    result.push({
      ...(original ?? {}),
      task_id: edited.task_id,
      description: edited.description,
      assigned_to: edited.assigned_to,
      complexity: edited.complexity,
      dependencies: edited.dependencies,
      status: "pending",
    });
  }

  return result;
}

export interface PreviewNodeOptions {
  previewProvider?: PreviewProvider | null;
  costConfig?: Partial<CostConfig>;
}

/**
 * Create the preview LangGraph node.
 *
 * Inserts between coordinator and the fan-out dispatch. On first invocation
 * with pending tasks, blocks until the user approves/edits/aborts via CLI
 * or the optional previewProvider (dashboard).
 */
export function createPreviewNode(
  options: PreviewNodeOptions = {},
): (state: GraphState) => Promise<Partial<GraphState>> {
  const { previewProvider, costConfig } = options;

  return async (state: GraphState): Promise<Partial<GraphState>> => {
    const existingPreview = state.preview as PreviewState | null;

    // Already processed — pass through
    if (existingPreview && existingPreview.status !== "pending") {
      return { __node__: "preview_gate" };
    }

    // Skip preview flag
    if (state.skip_preview) {
      log("Preview skipped (--no-preview)");
      return {
        preview: {
          tasks: [],
          estimate: { estimatedUSD: 0, parallelWaves: 0, rfcRequired: false, estimatedMinutes: 0 },
          status: "approved" as const,
        },
        __node__: "preview_gate",
      };
    }

    const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
    const previewTasks = extractPreviewTasks(taskQueue);

    // No pending tasks — nothing to preview
    if (previewTasks.length === 0) {
      return { __node__: "preview_gate" };
    }

    const estimate: CostEstimate = estimateCost(previewTasks, costConfig);

    const previewState: PreviewState = {
      tasks: previewTasks,
      estimate,
      status: "pending",
    };

    log(`Preview: ${previewTasks.length} tasks, ~$${estimate.estimatedUSD.toFixed(2)}, ${estimate.parallelWaves} waves`);

    // Collect user response — race CLI against optional dashboard provider
    let response: PreviewResponse;

    const canRenderSpinner = Boolean(
      process.stdout.isTTY && process.stderr.isTTY,
    );

    if (canRenderSpinner) {
      renderPreviewTable(previewTasks, estimate);

      if (previewProvider) {
        // Race CLI and dashboard
        const cliPromise = promptPreviewAction(previewTasks);
        const dashboardPromise = previewProvider(previewState);
        response = await Promise.race([cliPromise, dashboardPromise]);
      } else {
        response = await promptPreviewAction(previewTasks);
      }
    } else if (previewProvider) {
      // Non-TTY with dashboard — use dashboard only
      response = await previewProvider(previewState);
    } else {
      // Non-TTY, no dashboard — auto-approve
      log("Preview auto-approved (non-TTY, no dashboard)");
      response = { action: "approve" };
    }

    // Process response
    if (response.action === "abort") {
      log("Preview: user aborted");
      return {
        preview: { ...previewState, status: "aborted" },
        aborted: true,
        messages: ["Preview: Sprint aborted by user"],
        __node__: "preview_gate",
      };
    }

    if (response.action === "edit" && response.editedTasks) {
      log(`Preview: user edited tasks (${response.editedTasks.length} tasks)`);
      const updatedQueue = applyEdits(taskQueue, response.editedTasks);
      return {
        preview: {
          ...previewState,
          status: "edited",
          editedTasks: response.editedTasks,
        },
        task_queue: updatedQueue,
        total_tasks: response.editedTasks.length,
        messages: [`Preview: Sprint approved with ${response.editedTasks.length} edited tasks`],
        __node__: "preview_gate",
      };
    }

    // Approved
    log("Preview: user approved");
    return {
      preview: { ...previewState, status: "approved" },
      messages: [`Preview: Sprint approved — ${previewTasks.length} tasks, ~$${estimate.estimatedUSD.toFixed(2)}`],
      __node__: "preview_gate",
    };
  };
}
