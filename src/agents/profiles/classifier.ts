/**
 * Keyword-based task type classifier for agent performance profiles.
 */

import type { TaskType, ConfidenceGate } from "./types.js";
import { PROFILE_CONFIDENCE_THRESHOLDS } from "./types.js";

export const TASK_TYPE_KEYWORDS: Record<Exclude<TaskType, "general">, string[]> = {
  audit: ["audit", "review", "inspect", "verify", "validate", "check", "compliance", "lint", "scan"],
  research: ["research", "investigate", "explore", "analyze", "study", "evaluate", "compare", "survey", "benchmark"],
  implement: ["implement", "build", "create", "develop", "add", "feature", "integrate", "construct", "code", "write"],
  test: ["test", "spec", "coverage", "unit", "e2e", "integration", "assertion", "mock", "fixture"],
  refactor: ["refactor", "restructure", "reorganize", "simplify", "extract", "optimize", "clean", "deduplicate", "modularize"],
  document: ["document", "docs", "readme", "guide", "tutorial", "comment", "annotate", "changelog", "wiki"],
  design: ["design", "architect", "schema", "blueprint", "wireframe", "mockup", "prototype", "layout", "specification"],
  debug: ["debug", "fix", "bug", "error", "issue", "crash", "patch", "troubleshoot", "diagnose", "resolve"],
};

/**
 * Classify a task description into a TaskType by counting keyword hits per category.
 * Returns the category with the most matches, or "general" if none match.
 */
export function classifyTaskType(description: string): TaskType {
  const lower = description.toLowerCase();
  let bestType: TaskType = "general";
  let bestCount = 0;

  for (const [taskType, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    let count = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestType = taskType as TaskType;
    }
  }

  return bestType;
}

/**
 * Determine confidence gate based on total completed tasks for a profile.
 */
export function getConfidenceGate(taskCount: number): ConfidenceGate {
  if (taskCount >= PROFILE_CONFIDENCE_THRESHOLDS.USE_PROFILE) return "USE_PROFILE";
  if (taskCount >= PROFILE_CONFIDENCE_THRESHOLDS.PARTIAL_WEIGHT) return "PARTIAL_WEIGHT";
  return "IGNORE_PROFILE";
}
