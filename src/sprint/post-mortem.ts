/**
 * Post-mortem analyzer — rule-based extraction of lessons from sprint results.
 * No LLM calls. Analyzes failure patterns and extracts actionable lessons
 * for injection into subsequent runs.
 */

import type { SprintResult, SprintTask } from "./types.js";
import { debugLog, isDebugEnabled, truncateStr, TRUNCATION } from "../debug/logger.js";

export interface PostMortemResult {
  failedTasks: { task: string; error: string; suggestedFix: string }[];
  lessons: string[];
  avoidPatterns: string[];
  successPatterns: string[];
}

const MAX_LESSONS_PER_RUN = 3;
const MAX_TOTAL_LESSONS = 10;

interface FailureRule {
  pattern: RegExp;
  lesson: (task: SprintTask, match: RegExpMatchArray) => string;
  fix: (task: SprintTask, match: RegExpMatchArray) => string;
}

const FAILURE_RULES: FailureRule[] = [
  {
    pattern: /module\s+not\s+found|cannot\s+find\s+module|no\s+such\s+file|ENOENT/i,
    lesson: (_t) => "Add dependency installation and file creation to project setup task before implementation tasks",
    fix: (_t) => "ensure dependencies are installed in setup",
  },
  {
    pattern: /command\s+not\s+found|not\s+recognized|ENOENT.*bin/i,
    lesson: (_t) => "Verify required CLI tools are available before running commands",
    fix: (_t) => "check tool availability before use",
  },
  {
    pattern: /timeout|timed?\s*out|ETIMEDOUT|deadline\s+exceeded/i,
    lesson: (t) => `Break "${t.description.slice(0, 50)}" into smaller, focused subtasks`,
    fix: (_t) => "split into smaller tasks",
  },
  {
    pattern: /test.*fail|assert.*fail|expect.*received|FAIL\s+src/i,
    lesson: (_t) => "Verify implementation correctness before writing tests; ensure test setup (framework, config) is a separate earlier task",
    fix: (_t) => "verify implementation before testing",
  },
  {
    pattern: /syntax\s*error|unexpected\s+token|parsing\s+error/i,
    lesson: (_t) => "Include explicit file format and syntax requirements in task descriptions",
    fix: (_t) => "specify exact syntax in task description",
  },
  {
    pattern: /permission\s+denied|EACCES|forbidden/i,
    lesson: (_t) => "Check file and directory permissions before write operations",
    fix: (_t) => "ensure write permissions",
  },
  {
    pattern: /port\s+.*in\s+use|EADDRINUSE|already\s+listening/i,
    lesson: (_t) => "Use dynamic or non-default ports to avoid conflicts",
    fix: (_t) => "use a non-conflicting port",
  },
  {
    pattern: /type\s*error|is\s+not\s+a\s+function|undefined\s+is\s+not/i,
    lesson: (_t) => "Include type annotations and interface definitions in task descriptions to prevent type mismatches",
    fix: (_t) => "add explicit types",
  },
  {
    pattern: /import\s+error|cannot\s+use\s+import|require\s+is\s+not\s+defined/i,
    lesson: (_t) => "Specify module system (ESM vs CommonJS) in project setup and ensure consistent usage",
    fix: (_t) => "align module system across files",
  },
];

function classifyFailure(task: SprintTask): { lesson: string; fix: string } | null {
  const errorText = `${task.error ?? ""} ${task.result ?? ""}`;
  if (!errorText.trim()) return null;

  for (const rule of FAILURE_RULES) {
    const match = errorText.match(rule.pattern);
    if (match) {
      return { lesson: rule.lesson(task, match), fix: rule.fix(task, match) };
    }
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
