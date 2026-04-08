/**
 * CLI preview rendering — table + approval prompt using @clack/prompts.
 */

import { select, text, isCancel, log as clackLog } from "@clack/prompts";
import pc from "picocolors";
import type { PreviewTask, PreviewResponse, CostEstimate } from "../graph/preview/types.js";

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function formatDeps(deps: string[]): string {
  if (deps.length === 0) return "none";
  return deps.join(", ");
}

/**
 * Render the sprint preview table and cost summary to the terminal.
 */
export function renderPreviewTable(
  tasks: PreviewTask[],
  estimate: CostEstimate,
): void {
  const idW = 7;
  const taskW = 28;
  const agentW = 10;
  const depsW = 14;

  const hBorder = `${"─".repeat(idW + 2)}┬${"─".repeat(taskW + 2)}┬${"─".repeat(agentW + 2)}┬${"─".repeat(depsW + 2)}`;
  const sep     = `${"─".repeat(idW + 2)}┼${"─".repeat(taskW + 2)}┼${"─".repeat(agentW + 2)}┼${"─".repeat(depsW + 2)}`;
  const bBorder = `${"─".repeat(idW + 2)}┴${"─".repeat(taskW + 2)}┴${"─".repeat(agentW + 2)}┴${"─".repeat(depsW + 2)}`;

  const title = `Sprint Preview — ${tasks.length} tasks, ~${estimate.parallelWaves} parallel wave${estimate.parallelWaves !== 1 ? "s" : ""}`;
  const titleLine = pc.bold(title);

  const lines: string[] = [];
  lines.push(`┌${hBorder}┐`);
  lines.push(`│ ${titleLine}${" ".repeat(Math.max(0, idW + taskW + agentW + depsW + 8 - title.length - 1))}│`);
  lines.push(`├${sep}┤`);
  lines.push(
    `│ ${pc.dim(pad("ID", idW))} │ ${pc.dim(pad("Task", taskW))} │ ${pc.dim(pad("Agent", agentW))} │ ${pc.dim(pad("Deps", depsW))} │`,
  );
  lines.push(`├${sep}┤`);

  for (const t of tasks) {
    const desc = t.description.length > taskW
      ? t.description.slice(0, taskW - 1) + "…"
      : t.description;
    lines.push(
      `│ ${pad(t.task_id, idW)} │ ${pad(desc, taskW)} │ ${pad(t.assigned_to, agentW)} │ ${pad(formatDeps(t.dependencies), depsW)} │`,
    );
  }

  lines.push(`└${bBorder}┘`);

  const summaryParts: string[] = [];
  summaryParts.push(`Estimated tokens: ~${estimate.estimatedTokens?.toLocaleString() ?? "N/A"}`);
  summaryParts.push(`Parallel waves: ${estimate.parallelWaves}`);
  if (estimate.rfcRequired) {
    const rfcCount = tasks.filter(
      (t) => t.complexity === "HIGH" || t.complexity === "ARCHITECTURE",
    ).length;
    summaryParts.push(`Complexity flags: ${rfcCount} RFC required`);
  }

  lines.push(pc.dim(summaryParts.join("  │  ")));

  clackLog.info(lines.join("\n"));
}

/**
 * Show the preview approval prompt. Returns user's chosen action and optional edits.
 */
export async function promptPreviewAction(
  tasks: PreviewTask[],
): Promise<PreviewResponse> {
  const action = await select({
    message: "How would you like to proceed?",
    options: [
      { value: "approve" as const, label: "Approve and run" },
      { value: "edit" as const, label: "Edit tasks" },
      { value: "abort" as const, label: "Abort" },
    ],
  });

  if (isCancel(action)) {
    return { action: "abort" };
  }

  if (action === "approve") {
    return { action: "approve" };
  }

  if (action === "abort") {
    return { action: "abort" };
  }

  // Edit flow
  const editedTasks: PreviewTask[] = [];
  for (const task of tasks) {
    const shortDesc =
      task.description.length > 50
        ? task.description.slice(0, 47) + "..."
        : task.description;

    const taskAction = await select({
      message: `[${task.task_id}] ${shortDesc}`,
      options: [
        { value: "keep" as const, label: "Keep as-is" },
        { value: "edit" as const, label: "Edit description" },
        { value: "remove" as const, label: "Remove this task" },
      ],
    });

    if (isCancel(taskAction)) {
      return { action: "abort" };
    }

    if (taskAction === "remove") {
      continue;
    }

    if (taskAction === "edit") {
      const newDesc = await text({
        message: "New description:",
        initialValue: task.description,
        placeholder: task.description,
      });
      if (isCancel(newDesc)) {
        return { action: "abort" };
      }
      editedTasks.push({
        ...task,
        description: String(newDesc).trim() || task.description,
      });
    } else {
      editedTasks.push(task);
    }
  }

  if (editedTasks.length === 0) {
    clackLog.warn("All tasks removed. Aborting.");
    return { action: "abort" };
  }

  return { action: "edit", editedTasks };
}
