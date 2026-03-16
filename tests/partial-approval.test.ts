/**
 * Tests for src/agents/partial-approval.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPartialApprovalNode } from "../src/agents/partial-approval.js";
import type { GraphState } from "../src/core/graph-state.js";
import type { PartialApprovalDecision } from "../src/agents/partial-approval.js";

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
}));

vi.mock("../src/core/canvas-telemetry.js", () => ({
  getCanvasTelemetry: vi.fn().mockReturnValue({
    sendNodeActive: vi.fn(),
    sendWaitingForHuman: vi.fn(),
  }),
}));

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
    next_sprint_backlog: [],
    approval_stats: {},
    ...overrides,
  } as GraphState;
}

function makeTask(id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: id,
    description: `Task ${id}`,
    assigned_to: "bot_0",
    status,
    priority: "MEDIUM",
    retry_count: 0,
    max_retries: 2,
    result: null,
    ...extra,
  };
}

describe("createPartialApprovalNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when no tasks are waiting", async () => {
    const node = createPartialApprovalNode({});
    const state = makeState({ task_queue: [makeTask("T1", "completed")] });
    const result = await node(state);
    expect(result.__node__).toBe("partial_approval");
    expect(result.task_queue).toBeUndefined();
  });

  it("auto-approves all when sessionAutoApprove flag is set", async () => {
    const node = createPartialApprovalNode({ autoApprove: true });
    const state = makeState({
      task_queue: [
        makeTask("T1", "waiting_for_human"),
        makeTask("T2", "auto_approved_pending"),
      ],
    });
    const result = await node(state);
    const tasks = result.task_queue as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    expect(tasks[0].status).toBe("completed");
    expect(tasks[1].status).toBe("completed");
    const stats = result.approval_stats as Record<string, number>;
    expect(stats.autoApprovedCount).toBe(2);
  });

  it("all auto-approved tasks skip waiting and complete immediately", async () => {
    const node = createPartialApprovalNode({});
    const state = makeState({
      task_queue: [
        makeTask("T1", "auto_approved_pending"),
        makeTask("T2", "auto_approved_pending"),
      ],
    });
    const result = await node(state);
    const tasks = result.task_queue as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    expect(tasks[0].status).toBe("completed");
    expect(tasks[1].status).toBe("completed");
  });

  it("approves a task via provider", async () => {
    const provider = vi.fn().mockResolvedValue(
      new Map([["T1", { action: "approve" }]]),
    );
    const node = createPartialApprovalNode({ approvalProvider: provider });
    const state = makeState({
      task_queue: [makeTask("T1", "waiting_for_human")],
    });
    const result = await node(state);
    const tasks = result.task_queue as Record<string, unknown>[];
    expect(tasks[0].status).toBe("completed");
    const stats = result.approval_stats as Record<string, number>;
    expect(stats.manualApprovedCount).toBe(1);
  });

  it("rejects a task with feedback -> needs_rework", async () => {
    const provider = vi.fn().mockResolvedValue(
      new Map([["T1", { action: "reject", feedback: "Fix the bug" }]]),
    );
    const node = createPartialApprovalNode({ approvalProvider: provider });
    const state = makeState({
      task_queue: [makeTask("T1", "waiting_for_human")],
    });
    const result = await node(state);
    const tasks = result.task_queue as Record<string, unknown>[];
    expect(tasks[0].status).toBe("needs_rework");
    expect(tasks[0].reviewer_feedback).toBe("HUMAN FEEDBACK: Fix the bug");
    const stats = result.approval_stats as Record<string, number>;
    expect(stats.rejectedCount).toBe(1);
  });

  it("throws when rejecting without feedback", async () => {
    const provider = vi.fn().mockResolvedValue(
      new Map([["T1", { action: "reject", feedback: "" }]]),
    );
    const node = createPartialApprovalNode({ approvalProvider: provider });
    const state = makeState({
      task_queue: [makeTask("T1", "waiting_for_human")],
    });
    await expect(node(state)).rejects.toThrow("Feedback is required");
  });

  it("force-escalates when retryCount >= maxRetries on reject", async () => {
    const provider = vi.fn().mockResolvedValue(
      new Map([["T1", { action: "reject", feedback: "Too many retries" }]]),
    );
    const node = createPartialApprovalNode({ approvalProvider: provider });
    const state = makeState({
      task_queue: [makeTask("T1", "waiting_for_human", { retry_count: 2, max_retries: 2 })],
    });
    const result = await node(state);
    const tasks = result.task_queue as Record<string, unknown>[];
    expect(tasks[0].status).toBe("escalated");
    const backlog = result.next_sprint_backlog as Record<string, unknown>[];
    expect(backlog).toHaveLength(1);
  });

  it("escalates a task", async () => {
    const provider = vi.fn().mockResolvedValue(
      new Map([["T1", { action: "escalate" }]]),
    );
    const node = createPartialApprovalNode({ approvalProvider: provider });
    const state = makeState({
      task_queue: [makeTask("T1", "waiting_for_human")],
    });
    const result = await node(state);
    const tasks = result.task_queue as Record<string, unknown>[];
    expect(tasks[0].status).toBe("escalated");
    const backlog = result.next_sprint_backlog as Record<string, unknown>[];
    expect(backlog).toHaveLength(1);
    const stats = result.approval_stats as Record<string, number>;
    expect(stats.escalatedCount).toBe(1);
  });

  it("handles mixed decisions correctly", async () => {
    const decisions = new Map<string, PartialApprovalDecision>([
      ["T1", { action: "approve" }],
      ["T2", { action: "reject", feedback: "Needs work" }],
      ["T3", { action: "escalate" }],
    ]);
    const provider = vi.fn().mockResolvedValue(decisions);
    const node = createPartialApprovalNode({ approvalProvider: provider });
    const state = makeState({
      task_queue: [
        makeTask("T1", "waiting_for_human"),
        makeTask("T2", "waiting_for_human"),
        makeTask("T3", "waiting_for_human"),
      ],
    });
    const result = await node(state);
    const tasks = result.task_queue as Record<string, unknown>[];
    expect(tasks.find((t) => t.task_id === "T1")?.status).toBe("completed");
    expect(tasks.find((t) => t.task_id === "T2")?.status).toBe("needs_rework");
    expect(tasks.find((t) => t.task_id === "T3")?.status).toBe("escalated");
    const stats = result.approval_stats as Record<string, number>;
    expect(stats.manualApprovedCount).toBe(1);
    expect(stats.rejectedCount).toBe(1);
    expect(stats.escalatedCount).toBe(1);
  });

  it("auto-approves all in non-TTY without provider", async () => {
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, writable: true });
    try {
      const node = createPartialApprovalNode({});
      const state = makeState({
        task_queue: [makeTask("T1", "waiting_for_human")],
      });
      const result = await node(state);
      const tasks = result.task_queue as Record<string, unknown>[];
      expect(tasks[0].status).toBe("completed");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, writable: true });
    }
  });

  it("approval_stats counters are correct", async () => {
    const decisions = new Map<string, PartialApprovalDecision>([
      ["T1", { action: "approve" }],
      ["T2", { action: "approve" }],
    ]);
    const provider = vi.fn().mockResolvedValue(decisions);
    const node = createPartialApprovalNode({ approvalProvider: provider });
    const state = makeState({
      task_queue: [
        makeTask("T1", "auto_approved_pending"),
        makeTask("T2", "waiting_for_human"),
      ],
    });
    const result = await node(state);
    const stats = result.approval_stats as Record<string, number>;
    expect(stats.autoApprovedCount).toBe(1);
    expect(stats.manualApprovedCount).toBe(1);
    expect(stats.rejectedCount).toBe(0);
    expect(stats.escalatedCount).toBe(0);
  });
});
