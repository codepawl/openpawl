/**
 * Crew error classifier — env vs agent_logic distinction.
 *
 * Reactivates the v0.3 PR #77 strategy on the preserve list (spec §7.6).
 * The original sprint classifier looked at shell exit codes + stderr
 * patterns; this version keeps those rules and adds explicit signals
 * for the validator and the timeout enforcer that phase-executor wires
 * up.
 *
 * Public surface:
 *   - `classifyTaskError(signal, task)` returns
 *     `{ kind: TaskErrorKind, retry_eligible, reason }`
 *   - `shouldRetry(classification, retry_count)` enforces per-kind
 *     retry caps so the executor never has to memorize them.
 *
 * The `signal` is a typed discriminated union so callers can't pass
 * arbitrary `unknown` blobs and get silent misclassifications.
 */

import type { CrewTask, TaskErrorKind } from "./types.js";

export interface ShellErrorSignal {
  source: "shell_exec";
  exit_code: number;
  stderr: string;
  stdout?: string;
}

export interface ValidatorErrorSignal {
  source: "validator";
  reason: string;
}

export interface TimeoutErrorSignal {
  source: "timeout";
  budget_ms: number;
  elapsed_ms: number;
}

/** Catch-all for LLM API errors, parse failures, etc. */
export interface AgentErrorSignal {
  source: "agent_error";
  message: string;
}

export type ErrorSignal =
  | ShellErrorSignal
  | ValidatorErrorSignal
  | TimeoutErrorSignal
  | AgentErrorSignal;

export interface ErrorClassification {
  kind: TaskErrorKind;
  retry_eligible: boolean;
  reason: string;
}

const RE_COMMAND_NOT_FOUND = /command not found|^[a-z]+:.*not found/im;
const RE_MISSING_DEP =
  /cannot find module|module_not_found|cannot find package|err_module_not_found/i;
const RE_PERM = /eacces|permission denied|operation not permitted/i;
const RE_PORT_IN_USE = /eaddrinuse|address already in use|port .* (?:is|already) in use/i;
const RE_TIMEOUT = /\btimed out\b|\btimeout\b/i;

function classifyShell(sig: ShellErrorSignal): ErrorClassification {
  const stderr = sig.stderr ?? "";
  if (sig.exit_code === 127 || RE_COMMAND_NOT_FOUND.test(stderr)) {
    return {
      kind: "env_command_not_found",
      retry_eligible: false,
      reason: `shell command not found (exit ${sig.exit_code})`,
    };
  }
  if (RE_MISSING_DEP.test(stderr)) {
    return {
      kind: "env_missing_dep",
      retry_eligible: false,
      reason: "shell reported a missing module / package",
    };
  }
  if (RE_PERM.test(stderr)) {
    return {
      kind: "env_perm",
      retry_eligible: false,
      reason: "shell reported a permission error",
    };
  }
  if (RE_PORT_IN_USE.test(stderr)) {
    return {
      kind: "env_port_in_use",
      retry_eligible: false,
      reason: "shell reported an address-in-use error",
    };
  }
  if (RE_TIMEOUT.test(stderr)) {
    return {
      kind: "timeout",
      retry_eligible: false,
      reason: "shell reported a timeout",
    };
  }
  // Non-zero exit with no environmental signature ≈ logic/test failure.
  if (sig.exit_code !== 0) {
    return {
      kind: "agent_logic",
      retry_eligible: true,
      reason: `shell exited ${sig.exit_code} (no env signature)`,
    };
  }
  // Exit 0 with stderr is unusual; treat as agent_logic and let retry decide.
  return {
    kind: "agent_logic",
    retry_eligible: true,
    reason: "shell exited 0 but reported as failed by caller",
  };
}

export function classifyTaskError(
  signal: ErrorSignal,
  _task: CrewTask,
): ErrorClassification {
  switch (signal.source) {
    case "shell_exec":
      return classifyShell(signal);
    case "validator":
      return {
        kind: "agent_logic",
        retry_eligible: true,
        reason: `validator: ${signal.reason}`,
      };
    case "timeout":
      return {
        kind: "timeout",
        retry_eligible: false,
        reason: `wall time ${signal.elapsed_ms}ms exceeded budget ${signal.budget_ms}ms`,
      };
    case "agent_error":
      return {
        kind: "agent_logic",
        retry_eligible: true,
        reason: `agent error: ${signal.message}`,
      };
  }
}

export const RETRY_CAPS: Record<TaskErrorKind, number> = {
  env_command_not_found: 0,
  env_missing_dep: 0,
  env_perm: 0,
  env_port_in_use: 0,
  timeout: 0,
  agent_logic: 2,
  unknown: 1,
};

/**
 * Decide whether to retry based on the classification and how many
 * retries have already been spent. Pure function — caller passes the
 * retry counter from the task state.
 */
export function shouldRetry(
  classification: ErrorClassification,
  retry_count: number,
): boolean {
  if (!classification.retry_eligible) return false;
  const cap = RETRY_CAPS[classification.kind];
  return retry_count < cap;
}
