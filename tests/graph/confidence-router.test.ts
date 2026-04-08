import { describe, it, expect } from "bun:test";
import { getRoutingDecision, mapRoutingToStatus } from "@/graph/confidence/router.js";
import { DEFAULT_CONFIDENCE_THRESHOLDS } from "@/graph/confidence/types.js";
import { createConfidenceRouterNode } from "@/graph/nodes/confidence-router.js";
import type { GraphState } from "@/core/graph-state.js";

describe("getRoutingDecision", () => {
  it("routes to auto_approved for high scores", () => {
    expect(getRoutingDecision(0.90)).toBe("auto_approved");
    expect(getRoutingDecision(0.85)).toBe("auto_approved");
    expect(getRoutingDecision(1.0)).toBe("auto_approved");
  });

  it("routes to qa_review for medium scores", () => {
    expect(getRoutingDecision(0.70)).toBe("qa_review");
    expect(getRoutingDecision(0.60)).toBe("qa_review");
    expect(getRoutingDecision(0.84)).toBe("qa_review");
  });

  it("routes to rework for low-medium scores", () => {
    expect(getRoutingDecision(0.40)).toBe("rework");
    expect(getRoutingDecision(0.50)).toBe("rework");
    expect(getRoutingDecision(0.59)).toBe("rework");
  });

  it("routes to escalated for very low scores", () => {
    expect(getRoutingDecision(0.39)).toBe("escalated");
    expect(getRoutingDecision(0.0)).toBe("escalated");
    expect(getRoutingDecision(0.1)).toBe("escalated");
  });

  it("respects custom thresholds", () => {
    const custom = { autoApprove: 0.95, reviewRequired: 0.70, reworkRequired: 0.50 };
    expect(getRoutingDecision(0.90, custom)).toBe("qa_review");
    expect(getRoutingDecision(0.95, custom)).toBe("auto_approved");
    expect(getRoutingDecision(0.60, custom)).toBe("rework");
    expect(getRoutingDecision(0.40, custom)).toBe("escalated");
  });
});

describe("mapRoutingToStatus", () => {
  it("maps auto_approved to auto_approved_pending", () => {
    expect(mapRoutingToStatus("auto_approved", true)).toBe("auto_approved_pending");
    expect(mapRoutingToStatus("auto_approved", false)).toBe("auto_approved_pending");
  });

  it("maps qa_review to reviewing when reviewer exists", () => {
    expect(mapRoutingToStatus("qa_review", true)).toBe("reviewing");
  });

  it("maps qa_review to waiting_for_human when no reviewer", () => {
    expect(mapRoutingToStatus("qa_review", false)).toBe("waiting_for_human");
  });

  it("maps rework to needs_rework", () => {
    expect(mapRoutingToStatus("rework", true)).toBe("needs_rework");
  });

  it("maps escalated to waiting_for_human", () => {
    expect(mapRoutingToStatus("escalated", true)).toBe("waiting_for_human");
  });
});

describe("createConfidenceRouterNode", () => {
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
      ...overrides,
    } as GraphState;
  }

  it("passes through when no _send_task", () => {
    const router = createConfidenceRouterNode();
    const result = router(makeState());
    expect(result.__node__).toBe("confidence_router");
    expect(result.task_queue).toBeUndefined();
  });

  it("passes through when no confidence block in output", () => {
    const router = createConfidenceRouterNode();
    const state = makeState({
      _send_task: {
        task_id: "T1",
        status: "pending",
        result: { task_id: "T1", success: true, output: "No confidence here", quality_score: 0.8 },
        retry_count: 0,
        max_retries: 2,
      },
    });
    const result = router(state);
    expect(result.__node__).toBe("confidence_router");
    expect(result.task_queue).toBeUndefined();
  });

  it("routes high-confidence task to auto_approved", () => {
    const router = createConfidenceRouterNode({
      team: [{ id: "bot_0", name: "Bot", role_id: "software_engineer", traits: [], worker_url: "" }] as any[],
    });
    const state = makeState({
      _send_task: {
        task_id: "T1",
        status: "pending",
        result: {
          task_id: "T1",
          success: true,
          output: `Done.\n<confidence>\nscore: 0.92\nreasoning: Very confident\nflags:\n</confidence>`,
          quality_score: 0.8,
        },
        retry_count: 0,
        max_retries: 2,
      },
    });
    const result = router(state);
    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    expect(updatedTask?.status).toBe("auto_approved_pending");
    const taskResult = updatedTask?.result as Record<string, unknown>;
    expect(taskResult?.routing_decision).toBe("auto_approved");
  });

  it("escalates after max retries regardless of score", () => {
    const router = createConfidenceRouterNode();
    const state = makeState({
      _send_task: {
        task_id: "T1",
        status: "pending",
        result: {
          task_id: "T1",
          success: true,
          output: `Done.\n<confidence>\nscore: 0.45\nreasoning: Needs work\nflags: partial_completion\n</confidence>`,
          quality_score: 0.5,
        },
        retry_count: 2,
        max_retries: 2,
      },
      confidence_retry_count: 2,
      confidence_retry_max: 2,
    } as Partial<GraphState>);
    const result = router(state);
    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    expect(updatedTask?.status).toBe("waiting_for_human");
    const taskResult = updatedTask?.result as Record<string, unknown>;
    expect(taskResult?.routing_decision).toBe("escalated");
  });

  it("QA confidence >= 0.85 auto-approves", () => {
    const router = createConfidenceRouterNode({
      team: [
        { id: "bot_0", name: "Maker", role_id: "software_engineer", traits: [], worker_url: "" },
        { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: [], worker_url: "" },
      ] as any[],
    });
    const state = makeState({
      _send_task: {
        task_id: "T1",
        status: "reviewing",
        result: {
          task_id: "T1",
          success: true,
          output: `Looks good.\n<confidence>\nscore: 0.90\nreasoning: High quality\nflags:\n</confidence>`,
          quality_score: 0.9,
        },
        retry_count: 0,
        max_retries: 2,
      },
    });
    const result = router(state);
    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    expect(updatedTask?.status).toBe("auto_approved_pending");
    const taskResult = updatedTask?.result as Record<string, unknown>;
    expect(taskResult?.routing_decision).toBe("auto_approved");
  });

  it("QA confidence < 0.85 sends to rework", () => {
    const router = createConfidenceRouterNode({
      team: [
        { id: "bot_0", name: "Maker", role_id: "software_engineer", traits: [], worker_url: "" },
        { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: [], worker_url: "" },
      ] as any[],
    });
    const state = makeState({
      _send_task: {
        task_id: "T1",
        status: "reviewing",
        result: {
          task_id: "T1",
          success: true,
          output: `Issues found.\n<confidence>\nscore: 0.70\nreasoning: Some problems\nflags: partial_completion\n</confidence>`,
          quality_score: 0.6,
        },
        retry_count: 0,
        max_retries: 2,
      },
    });
    const result = router(state);
    const updatedTask = (result.task_queue as Record<string, unknown>[])?.[0];
    expect(updatedTask?.status).toBe("needs_rework");
    const taskResult = updatedTask?.result as Record<string, unknown>;
    expect(taskResult?.routing_decision).toBe("rework");
    expect(updatedTask?.assigned_to).toBe("bot_0");
  });
});
