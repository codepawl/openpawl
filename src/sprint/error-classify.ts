/**
 * Error classifier for sprint tasks.
 *
 * Mirrors the translateError pattern in src/engine/errors.ts:223-251 but for
 * tool/environment errors rather than LLM provider errors. Consumed by:
 *  - src/sprint/sprint-runner.ts isRetriable — skip retry for env_* and timeout
 *  - src/sprint/post-mortem.ts — derive lessons from failure kinds
 *
 * Prefers structured fields (exitCode, stderr) over regex when available.
 */

import type { SprintTask } from "./types.js";

export type ErrorKind =
  | "env_command_not_found"
  | "env_missing_dep"
  | "env_perm"
  | "env_port_in_use"
  | "timeout"
  | "agent_logic"
  | "unknown";

export interface ClassifyInput {
  errorText?: string;
  stderr?: string;
  exitCode?: number;
  resultText?: string;
}

export interface Classification {
  kind: ErrorKind;
  /** Short human-readable hint about why we classified this way. */
  signal?: string;
}

interface Rule {
  kind: ErrorKind;
  pattern: RegExp;
  signal: (match: RegExpMatchArray) => string;
  lesson: (task: SprintTask, match: RegExpMatchArray) => string;
  fix: string;
}

/**
 * Rules ordered by specificity. "command not found" must precede "module not
 * found" so a missing CLI (`npm: command not found`) is classified correctly
 * before the broader "no such file" fallback catches it.
 */
export const FAILURE_RULES: Rule[] = [
  {
    kind: "env_command_not_found",
    pattern: /command\s+not\s+found|not\s+recognized|ENOENT.*bin/i,
    signal: () => "command not found",
    lesson: () => "Verify required CLI tools are available before running commands",
    fix: "check tool availability before use",
  },
  {
    kind: "env_missing_dep",
    pattern: /module\s+not\s+found|cannot\s+find\s+module|no\s+such\s+file|ENOENT/i,
    signal: () => "module/file not found",
    lesson: () => "Add dependency installation and file creation to project setup task before implementation tasks",
    fix: "ensure dependencies are installed in setup",
  },
  {
    kind: "timeout",
    pattern: /timeout|timed?\s*out|ETIMEDOUT|deadline\s+exceeded/i,
    signal: () => "timed out",
    lesson: (t) => `Break "${t.description.slice(0, 50)}" into smaller, focused subtasks`,
    fix: "split into smaller tasks",
  },
  {
    kind: "agent_logic",
    pattern: /test.*fail|assert.*fail|expect.*received|FAIL\s+src/i,
    signal: () => "test assertion failed",
    lesson: () => "Verify implementation correctness before writing tests; ensure test setup (framework, config) is a separate earlier task",
    fix: "verify implementation before testing",
  },
  {
    kind: "agent_logic",
    pattern: /syntax\s*error|unexpected\s+token|parsing\s+error/i,
    signal: () => "syntax error",
    lesson: () => "Include explicit file format and syntax requirements in task descriptions",
    fix: "specify exact syntax in task description",
  },
  {
    kind: "env_perm",
    pattern: /permission\s+denied|EACCES|forbidden/i,
    signal: () => "permission denied",
    lesson: () => "Check file and directory permissions before write operations",
    fix: "ensure write permissions",
  },
  {
    kind: "env_port_in_use",
    pattern: /port\s+.*in\s+use|EADDRINUSE|already\s+listening/i,
    signal: () => "port in use",
    lesson: () => "Use dynamic or non-default ports to avoid conflicts",
    fix: "use a non-conflicting port",
  },
  {
    kind: "agent_logic",
    pattern: /type\s*error|is\s+not\s+a\s+function|undefined\s+is\s+not/i,
    signal: () => "type error",
    lesson: () => "Include type annotations and interface definitions in task descriptions to prevent type mismatches",
    fix: "add explicit types",
  },
  {
    kind: "agent_logic",
    pattern: /import\s+error|cannot\s+use\s+import|require\s+is\s+not\s+defined/i,
    signal: () => "import error",
    lesson: () => "Specify module system (ESM vs CommonJS) in project setup and ensure consistent usage",
    fix: "align module system across files",
  },
];

/**
 * Classify an error using structured fields first, regex fallback second.
 * Returns { kind: "unknown" } if the input is empty or nothing matches.
 */
export function classifyError(input: ClassifyInput): Classification {
  // Structured first: exit 127 means shell couldn't find the command.
  if (input.exitCode === 127) {
    return { kind: "env_command_not_found", signal: "exit 127" };
  }

  const text = `${input.errorText ?? ""} ${input.stderr ?? ""} ${input.resultText ?? ""}`;
  if (!text.trim()) return { kind: "unknown" };

  for (const rule of FAILURE_RULES) {
    const match = text.match(rule.pattern);
    if (match) return { kind: rule.kind, signal: rule.signal(match) };
  }
  return { kind: "unknown" };
}

/**
 * Return the full rule (with lesson + fix) that matches the given error text,
 * or null if nothing matches. Used by post-mortem to extract lessons.
 */
export function matchFailureRule(errorText: string): Rule | null {
  if (!errorText.trim()) return null;
  for (const rule of FAILURE_RULES) {
    if (rule.pattern.test(errorText)) return rule;
  }
  return null;
}

/**
 * Build a classifier input from a SprintTask. Prefers the last shell_exec
 * failure (structured) over task.error (text).
 */
export function classifyTask(task: SprintTask): Classification {
  const results = task.toolCallResults ?? [];
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i]!;
    if (r.name === "shell_exec" && typeof r.exitCode === "number" && r.exitCode !== 0) {
      return classifyError({ exitCode: r.exitCode, stderr: r.stderrHead, errorText: task.error });
    }
  }
  return classifyError({ errorText: task.error, resultText: task.result });
}
