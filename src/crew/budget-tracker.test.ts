import { describe, expect, it } from "bun:test";

import { BudgetTracker } from "./budget-tracker.js";
import { CrewTaskSchema } from "./types.js";

function task(id: string, phase_id = "p1", max_per_task = 10_000) {
  return CrewTaskSchema.parse({
    id,
    phase_id,
    description: "x",
    assigned_agent: "coder",
    max_tokens_per_task: max_per_task,
  });
}

describe("BudgetTracker — aggregator math", () => {
  it("recordTaskTokens accumulates phase and session totals", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 100_000,
      max_tokens_per_phase: 50_000,
    });
    t.recordTaskTokens({ task_id: "t1", phase_id: "p1", input: 100, output: 50 });
    t.recordTaskTokens({ task_id: "t2", phase_id: "p1", input: 200, output: 75 });
    t.recordTaskTokens({ task_id: "t3", phase_id: "p2", input: 50, output: 25 });

    expect(t.phaseTokensUsed("p1")).toBe(425);
    expect(t.phaseTokensUsed("p2")).toBe(75);
    expect(t.sessionTokensUsed()).toBe(500);
  });

  it("recordPhaseEnd snapshots the running phase total", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 100_000,
      max_tokens_per_phase: 50_000,
    });
    t.recordTaskTokens({ task_id: "t1", phase_id: "p1", input: 1, output: 2 });
    expect(t.recordPhaseEnd("p1").phase_tokens).toBe(3);
    expect(t.recordPhaseEnd("p2").phase_tokens).toBe(0);
  });

  it("negative inputs are clamped to zero", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 100,
      max_tokens_per_phase: 100,
    });
    t.recordTaskTokens({ task_id: "t1", phase_id: "p1", input: -50, output: 10 });
    expect(t.sessionTokensUsed()).toBe(10);
  });
});

describe("BudgetTracker — pre-exec rejection at each scope", () => {
  it("rejects when requested > task.max_tokens_per_task", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 1_000_000,
      max_tokens_per_phase: 1_000_000,
    });
    const r = t.checkBeforeTask(task("t1", "p1", 1_000), 800, 500);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.scope).toBe("task");
      expect(r.cap).toBe(1_000);
      expect(r.attempted).toBe(1_300);
    }
  });

  it("rejects when phase total + requested would exceed phase cap", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 1_000_000,
      max_tokens_per_phase: 5_000,
    });
    t.recordTaskTokens({ task_id: "t1", phase_id: "p1", input: 4_000, output: 800 });
    const r = t.checkBeforeTask(task("t2", "p1"), 200, 200);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.scope).toBe("phase");
      expect(r.current).toBe(4_800);
      expect(r.attempted).toBe(400);
    }
  });

  it("rejects when session total + requested would exceed session cap", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 5_000,
      max_tokens_per_phase: 100_000,
    });
    t.recordTaskTokens({ task_id: "t1", phase_id: "p1", input: 4_000, output: 500 });
    const r = t.checkBeforeTask(task("t2", "p1"), 400, 200);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.scope).toBe("session");
      expect(r.cap).toBe(5_000);
    }
  });

  it("checks return the FIRST failing scope (task before phase before session)", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 100,
      max_tokens_per_phase: 100,
    });
    // Task cap is the smallest → should fail on task scope first.
    const r = t.checkBeforeTask(task("t1", "p1", 50), 30, 30);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.scope).toBe("task");
  });

  it("admits when every scope has headroom", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 100_000,
      max_tokens_per_phase: 50_000,
    });
    const r = t.checkBeforeTask(task("t1", "p1", 5_000), 200, 200);
    expect(r.allowed).toBe(true);
  });
});

describe("BudgetTracker — session exhaustion flag", () => {
  it("isSessionExhausted flips when the running total crosses the cap", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 1_000,
      max_tokens_per_phase: 100_000,
    });
    expect(t.isSessionExhausted()).toBe(false);
    t.recordTaskTokens({ task_id: "t1", phase_id: "p1", input: 600, output: 400 });
    expect(t.isSessionExhausted()).toBe(true);
    expect(t.remainingSession()).toBe(0);
  });

  it("remainingSession reflects the gap to cap", () => {
    const t = new BudgetTracker({
      max_tokens_per_session: 1_000,
      max_tokens_per_phase: 100_000,
    });
    t.recordTaskTokens({ task_id: "t1", phase_id: "p1", input: 100, output: 200 });
    expect(t.remainingSession()).toBe(700);
  });
});
