import { describe, it, expect } from "bun:test";
import { createConfidenceRouterNode } from "@/graph/nodes/confidence-router.js";
import { isRetryableFailure } from "@/graph/confidence/types.js";
import type { GraphState } from "@/core/graph-state.js";

function makeState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    cycle_count: 0,
    session_active: true,
    last_action: "",
    messages: [],
    last_quality_score: 0,
    death_reason: null,
    generation_id: 1,
    ancestral_lessons: [],
    team: [],
    agent_messages: [],
    user_goal: null,
    project_context: "",
    task_queue: [],
    bot_stats: {},
    approval_pending: null,
    approval_response: null,
    __node__: null,
    planning_document: null,
    architecture_document: null,
    rfc_document: null,
    deep_work_mode: false,
    last_pulse_timestamp: 0,
    pulse_interval_ms: 30_000,
    mid_sprint_reported: false,
    total_tasks: 0,
    completed_tasks: 0,
    parallelism_depth: 0,
    retrieved_memories: "",
    preferences_context: "",
    preview: null,
    aborted: false,
    skip_preview: false,
    _send_task: null,
    _send_bot_id: "",
    average_confidence: 0,
    low_confidence_tasks: [],
    confidence_history: [],
    confidence_retry_count: 0,
    confidence_retry_max: 2,
    confidence_failure_reasons: [],
    ...overrides,
  } as GraphState;
}

const TEAM_WITH_MAKER = [
  { id: "bot_0", name: "Maker", role_id: "software_engineer", traits: [], worker_url: "" },
] as any[];

function makeTaskWithConfidence(score: number, reasoning: string, flags: string = ""): Record<string, unknown> {
  return {
    task_id: "T1",
    status: "pending",
    result: {
      task_id: "T1",
      success: true,
      output: `Done.\n<confidence>\nscore: ${score}\nreasoning: ${reasoning}\nflags: ${flags}\n</confidence>`,
      quality_score: 0.5,
    },
    retry_count: 0,
    max_retries: 2,
  };
}

describe("isRetryableFailure", () => {
  it("returns true for retryable reasons", () => {
    expect(isRetryableFailure(["Task is only partially completed"])).toBe(true);
    expect(isRetryableFailure(["Missing some context"])).toBe(true);
    expect(isRetryableFailure(["Needs more tests"])).toBe(true);
  });

  it("returns false when a non-retryable pattern is present", () => {
    expect(isRetryableFailure(["Contradicts existing architecture"])).toBe(false);
    expect(isRetryableFailure(["Requires external service to work"])).toBe(false);
    expect(isRetryableFailure(["Security vulnerability found in approach"])).toBe(false);
    expect(isRetryableFailure(["Fundamental design issue"])).toBe(false);
    expect(isRetryableFailure(["Resource not available"])).toBe(false);
    expect(isRetryableFailure(["Outside project scope"])).toBe(false);
  });

  it("returns false if any reason is non-retryable", () => {
    expect(isRetryableFailure(["Partially done", "Requires external service"])).toBe(false);
  });
});

describe("confidence gate retry path", () => {
  it("retryable failure triggers retry with specific context", () => {
    const router = createConfidenceRouterNode({ team: TEAM_WITH_MAKER });
    // Score 0.45 → rework decision
    const state = makeState({
      _send_task: makeTaskWithConfidence(0.45, "Needs more error handling", "partial_completion"),
      confidence_retry_count: 0,
      confidence_retry_max: 2,
    });

    const result = router(state);

    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    expect(updatedTask?.status).toBe("needs_rework");
    expect(updatedTask?.assigned_to).toBe("bot_0");

    const taskResult = updatedTask?.result as Record<string, unknown>;
    expect(taskResult?.retry_context).toBeDefined();
    expect(taskResult?.retry_context).toContain("Quality check failed");
    expect(taskResult?.retry_context).toContain("attempt 1 of 2");

    expect(result.confidence_retry_count).toBe(1);
    expect(result.confidence_failure_reasons).toBeDefined();
    expect((result.confidence_failure_reasons as string[]).length).toBeGreaterThan(0);

    const messages = result.messages as string[];
    expect(messages).toBeDefined();
    expect(messages.some((m) => m.includes("retry") || m.includes("retries"))).toBe(true);
  });

  it("non-retryable failure goes to human_review immediately", () => {
    const router = createConfidenceRouterNode({ team: TEAM_WITH_MAKER });
    // Score 0.45 → rework, but reasoning is non-retryable
    const state = makeState({
      _send_task: makeTaskWithConfidence(0.45, "Requires external service to validate", "external_dependency"),
      confidence_retry_count: 0,
      confidence_retry_max: 2,
    });

    const result = router(state);

    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    expect(updatedTask?.status).toBe("waiting_for_human");

    const taskResult = updatedTask?.result as Record<string, unknown>;
    expect(taskResult?.routing_decision).toBe("escalated");
    expect(taskResult?.non_retryable).toBe(true);

    // Should not have incremented retry count
    expect(result.confidence_retry_count).toBeUndefined();

    const messages = result.messages as string[];
    expect(messages.some((m) => m.includes("Non-retryable"))).toBe(true);
  });

  it("exhausted retries (count >= max) goes to human_review", () => {
    const router = createConfidenceRouterNode({ team: TEAM_WITH_MAKER });
    const state = makeState({
      _send_task: makeTaskWithConfidence(0.45, "Needs more error handling", "partial_completion"),
      confidence_retry_count: 2,
      confidence_retry_max: 2,
    });

    const result = router(state);

    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    expect(updatedTask?.status).toBe("waiting_for_human");

    const taskResult = updatedTask?.result as Record<string, unknown>;
    expect(taskResult?.routing_decision).toBe("escalated");
    expect(taskResult?.retries_exhausted).toBe(true);

    const messages = result.messages as string[];
    expect(messages.some((m) => m.includes("failed after 2 attempts"))).toBe(true);
  });

  it("confidence_retry_count increments correctly across retries", () => {
    const router = createConfidenceRouterNode({ team: TEAM_WITH_MAKER });

    // First retry
    const state1 = makeState({
      _send_task: makeTaskWithConfidence(0.45, "Partial work done", "partial_completion"),
      confidence_retry_count: 0,
      confidence_retry_max: 2,
    });
    const result1 = router(state1);
    expect(result1.confidence_retry_count).toBe(1);

    // Second retry
    const state2 = makeState({
      _send_task: makeTaskWithConfidence(0.45, "Still partial work", "partial_completion"),
      confidence_retry_count: 1,
      confidence_retry_max: 2,
    });
    const result2 = router(state2);
    expect(result2.confidence_retry_count).toBe(2);

    // Third attempt — exhausted
    const state3 = makeState({
      _send_task: makeTaskWithConfidence(0.45, "Still not done", "partial_completion"),
      confidence_retry_count: 2,
      confidence_retry_max: 2,
    });
    const result3 = router(state3);
    expect(result3.confidence_retry_count).toBeUndefined(); // exhausted path doesn't increment
    const task3 = (result3.task_queue as Record<string, unknown>[])?.[0];
    expect(task3?.status).toBe("waiting_for_human");
  });

  it("failure reasons are stored in state", () => {
    const router = createConfidenceRouterNode({ team: TEAM_WITH_MAKER });
    const state = makeState({
      _send_task: makeTaskWithConfidence(0.45, "Missing test coverage", "partial_completion"),
      confidence_retry_count: 0,
      confidence_retry_max: 2,
    });

    const result = router(state);

    const reasons = result.confidence_failure_reasons as string[];
    expect(reasons).toBeDefined();
    expect(reasons.length).toBeGreaterThan(0);
    // Should include the flag description and reasoning
    expect(reasons.some((r) => r.includes("partially completed"))).toBe(true);
    expect(reasons.some((r) => r.includes("Missing test coverage"))).toBe(true);
  });

  it("escalated score (<0.40) with retryable reasons still triggers retry", () => {
    const router = createConfidenceRouterNode({ team: TEAM_WITH_MAKER });
    // Score 0.30 → escalated decision, but retryable
    const state = makeState({
      _send_task: makeTaskWithConfidence(0.30, "Incomplete implementation", "partial_completion"),
      confidence_retry_count: 0,
      confidence_retry_max: 2,
    });

    const result = router(state);
    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    // Should retry instead of immediately escalating
    expect(updatedTask?.status).toBe("needs_rework");
    expect(result.confidence_retry_count).toBe(1);
  });

  it("auto_approved and qa_review paths are not affected by retry logic", () => {
    const router = createConfidenceRouterNode({ team: TEAM_WITH_MAKER });
    // High score → auto_approved, should not touch retry fields
    const state = makeState({
      _send_task: makeTaskWithConfidence(0.92, "Very confident", ""),
      confidence_retry_count: 0,
      confidence_retry_max: 2,
    });

    const result = router(state);
    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    expect(updatedTask?.status).toBe("auto_approved_pending");
    expect(result.confidence_retry_count).toBeUndefined();
    expect(result.confidence_failure_reasons).toBeUndefined();
  });
});
