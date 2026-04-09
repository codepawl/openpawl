/**
 * Task parser — extracts structured tasks from planner LLM output.
 * Tries JSON first (fenced or raw), falls back to numbered list parsing.
 */
import type { SprintTask } from "./types.js";

export function parseTasks(plannerOutput: string): SprintTask[] {
  if (!plannerOutput.trim()) return [];

  // Try JSON in fenced code block
  const fencedMatch = plannerOutput.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fencedMatch) {
    const parsed = tryParseJsonTasks(fencedMatch[1]!);
    if (parsed.length > 0) return parsed;
  }

  // Try raw JSON array
  const bracketMatch = plannerOutput.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    const parsed = tryParseJsonTasks(bracketMatch[0]!);
    if (parsed.length > 0) return parsed;
  }

  // Fallback: numbered list (1. Description, 2. Description, ...)
  return parseNumberedList(plannerOutput);
}

function tryParseJsonTasks(jsonStr: string): SprintTask[] {
  try {
    const arr = JSON.parse(jsonStr.trim());
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((item: unknown) => typeof item === "object" && item !== null && "description" in item)
      .map((item: Record<string, unknown>, i: number) => {
        const task: SprintTask = {
          id: `task-${i + 1}`,
          description: String(item["description"]),
          status: "pending" as const,
        };
        if (Array.isArray(item["dependsOn"])) {
          const deps = (item["dependsOn"] as unknown[]).filter((n): n is number => typeof n === "number");
          if (deps.length > 0) task.dependsOn = deps;
        }
        return task;
      });
  } catch {
    return [];
  }
}

function parseNumberedList(text: string): SprintTask[] {
  const tasks: SprintTask[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const match = line.match(/^\s*\d+\.\s+(.+)/);
    if (match) {
      tasks.push({
        id: `task-${tasks.length + 1}`,
        description: match[1]!.trim(),
        status: "pending",
      });
    }
  }

  return tasks;
}
