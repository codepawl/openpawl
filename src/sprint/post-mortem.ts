/**
 * Post-mortem analyzer — rule-based extraction of lessons from sprint results.
 * No LLM calls. Analyzes failure patterns and extracts actionable lessons
 * for injection into subsequent runs.
 */

import type { SprintResult, SprintTask } from "./types.js";
import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "../debug/logger.js";
import { matchFailureRule } from "./error-classify.js";

export interface PostMortemResult {
  failedTasks: { task: string; error: string; suggestedFix: string }[];
  lessons: string[];
  avoidPatterns: string[];
  successPatterns: string[];
}

const MAX_LESSONS_PER_RUN = 3;
const MAX_TOTAL_LESSONS = 10;

function classifyFailure(task: SprintTask): { lesson: string; fix: string } | null {
  const errorText = `${task.error ?? ""} ${task.result ?? ""}`;
  if (!errorText.trim()) return null;

  const rule = matchFailureRule(errorText);
  if (rule) {
    const match = errorText.match(rule.pattern)!;
    return { lesson: rule.lesson(task, match), fix: rule.fix };
  }

  // Generic fallback for unclassified errors
  const shortError = (task.error ?? "unknown error").slice(0, 80);
  return {
    lesson: `Review and fix: "${task.description.slice(0, 50)}" failed with: ${shortError}`,
    fix: "review error and adjust approach",
  };
}

/**
 * Analyze a sprint result and extract lessons for subsequent runs.
 * Pure rule-based — no LLM calls.
 */
export function analyzeRunResult(
  result: SprintResult,
  previousLessons?: string[],
): PostMortemResult {
  const failedTasks: PostMortemResult["failedTasks"] = [];
  const lessons: string[] = [];
  const avoidPatterns: string[] = [];
  const successPatterns: string[] = [];
  const prevSet = new Set((previousLessons ?? []).map((l) => l.toLowerCase()));

  // Analyze failed and incomplete tasks
  for (const task of result.tasks) {
    if (task.status !== "failed" && task.status !== "incomplete") continue;

    const classification = classifyFailure(task);
    if (!classification) continue;

    failedTasks.push({
      task: task.description,
      error: (task.error ?? "unknown").slice(0, 120),
      suggestedFix: classification.fix,
    });

    // Deduplicate against previous lessons
    if (!prevSet.has(classification.lesson.toLowerCase())) {
      lessons.push(classification.lesson);
    }

    // If this task description was already attempted (lesson mentions it), mark as avoid
    const descLower = task.description.toLowerCase();
    for (const prev of previousLessons ?? []) {
      if (prev.toLowerCase().includes(descLower.slice(0, 30))) {
        avoidPatterns.push(`Previously failed: "${task.description.slice(0, 60)}" — try a different approach`);
        break;
      }
    }
  }

  // Extract success patterns from completed tasks
  for (const task of result.tasks) {
    if (task.status !== "completed") continue;
    const verb = task.description.split(/\s+/).slice(0, 2).join(" ");
    successPatterns.push(`${verb} worked for: ${task.description.slice(0, 60)}`);
  }

  // Cap lessons per run
  const cappedLessons = lessons.slice(0, MAX_LESSONS_PER_RUN);

  // Cap total accumulated (caller is responsible but we enforce here too)
  const totalAfter = (previousLessons?.length ?? 0) + cappedLessons.length;
  const finalLessons = totalAfter > MAX_TOTAL_LESSONS
    ? cappedLessons.slice(0, Math.max(1, MAX_TOTAL_LESSONS - (previousLessons?.length ?? 0)))
    : cappedLessons;

  const resultObj = {
    failedTasks,
    lessons: finalLessons,
    avoidPatterns: avoidPatterns.slice(0, 3),
    successPatterns: successPatterns.slice(0, 5),
  };

  // Debug: log post-mortem results
  if (isDebugEnabled()) {
    debugLog("info", "sprint", "sprint:post_mortem", {
      data: {
        failedCount: failedTasks.length,
        lessonCount: finalLessons.length,
        lessons: finalLessons.map((l) => truncateStr(l, TRUNCATION.postMortemLesson)),
        avoidPatterns: resultObj.avoidPatterns.length,
        successPatterns: resultObj.successPatterns.length,
        previousLessonCount: previousLessons?.length ?? 0,
      },
    });
  }

  return resultObj;
}
