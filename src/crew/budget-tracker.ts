/**
 * BudgetTracker — three-scope token accounting per spec §3 Decision 5.
 *
 * Caps:
 *   - `max_tokens_per_task` lives on `CrewTask` itself. The task-scope
 *     check here just defers to that field.
 *   - `max_tokens_per_phase` is a per-phase rolling cap; the tracker
 *     accumulates `tokens_used` per `phase_id` as tasks complete.
 *   - `max_tokens_per_session` is the rolling sum across phases.
 *
 * Pre-execution check: caller estimates `(input + max_completion)` for
 * the upcoming LLM call and asks `checkBeforeTask`. If allowing the
 * call would push any scope over its cap, the tracker returns a
 * structured `BudgetExceeded` and the caller decides what to do
 * (typically: mark the task `blocked` with reason `"budget_exceeded"`,
 * skip execution, continue with the next task).
 *
 * Post-execution: caller calls `recordTaskTokens` with the actual
 * input + output observed. The tracker rolls up into both phase and
 * session totals. The final session total is what the runner emits in
 * the `crew:done` event and is what we stop at on session-budget
 * exhaustion.
 */

import type { CrewTask } from "./types.js";

export interface BudgetTrackerOptions {
  max_tokens_per_session: number;
  max_tokens_per_phase: number;
}

export type BudgetScope = "task" | "phase" | "session";

export interface BudgetCheckOk {
  allowed: true;
}

export interface BudgetExceeded {
  allowed: false;
  kind: "BudgetExceeded";
  scope: BudgetScope;
  cap: number;
  current: number;
  attempted: number;
  message: string;
}

export type BudgetCheckResult = BudgetCheckOk | BudgetExceeded;

export interface PhaseEndStats {
  phase_tokens: number;
}

export class BudgetTracker {
  private phaseTotals = new Map<string, number>();
  private sessionTotal = 0;
  private sessionExhausted = false;

  constructor(private readonly opts: BudgetTrackerOptions) {}

  /**
   * Pre-flight check before invoking a subagent for `task`. Returns
   * `BudgetExceeded` for the **first** scope to fail (task → phase →
   * session) so callers see the tightest binding cap.
   */
  checkBeforeTask(
    task: CrewTask,
    estimated_in: number,
    estimated_out: number,
  ): BudgetCheckResult {
    const requested = estimated_in + estimated_out;

    if (requested > task.max_tokens_per_task) {
      return {
        allowed: false,
        kind: "BudgetExceeded",
        scope: "task",
        cap: task.max_tokens_per_task,
        current: 0,
        attempted: requested,
        message: `task '${task.id}' input+max_completion ${requested} exceeds task cap ${task.max_tokens_per_task}`,
      };
    }

    const phaseCurrent = this.phaseTotals.get(task.phase_id) ?? 0;
    if (phaseCurrent + requested > this.opts.max_tokens_per_phase) {
      return {
        allowed: false,
        kind: "BudgetExceeded",
        scope: "phase",
        cap: this.opts.max_tokens_per_phase,
        current: phaseCurrent,
        attempted: requested,
        message: `phase '${task.phase_id}' would exceed phase cap (${phaseCurrent} + ${requested} > ${this.opts.max_tokens_per_phase})`,
      };
    }

    if (this.sessionTotal + requested > this.opts.max_tokens_per_session) {
      return {
        allowed: false,
        kind: "BudgetExceeded",
        scope: "session",
        cap: this.opts.max_tokens_per_session,
        current: this.sessionTotal,
        attempted: requested,
        message: `session would exceed cap (${this.sessionTotal} + ${requested} > ${this.opts.max_tokens_per_session})`,
      };
    }

    return { allowed: true };
  }

  /** Accumulate observed tokens for a finished task. */
  recordTaskTokens(args: {
    task_id: string;
    phase_id: string;
    input: number;
    output: number;
  }): void {
    const used = Math.max(0, args.input) + Math.max(0, args.output);
    this.phaseTotals.set(
      args.phase_id,
      (this.phaseTotals.get(args.phase_id) ?? 0) + used,
    );
    this.sessionTotal += used;
    if (this.sessionTotal >= this.opts.max_tokens_per_session) {
      this.sessionExhausted = true;
    }
  }

  /** Snapshot the rolling phase total at phase end. */
  recordPhaseEnd(phase_id: string): PhaseEndStats {
    return {
      phase_tokens: this.phaseTotals.get(phase_id) ?? 0,
    };
  }

  sessionTokensUsed(): number {
    return this.sessionTotal;
  }

  phaseTokensUsed(phase_id: string): number {
    return this.phaseTotals.get(phase_id) ?? 0;
  }

  isSessionExhausted(): boolean {
    return this.sessionExhausted;
  }

  remainingSession(): number {
    return Math.max(0, this.opts.max_tokens_per_session - this.sessionTotal);
  }
}
