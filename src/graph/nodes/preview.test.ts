/**
 * Tests for the preview node and cost estimator.
 */

import { describe, it, expect, vi } from "vitest";
import { createPreviewNode } from "./preview.js";
import { estimateCost, calculateWaves } from "../preview/estimator.js";
import type { GraphState } from "../../core/graph-state.js";
import type { PreviewTask, PreviewState, PreviewResponse } from "../preview/types.js";

function makeTask(overrides: Partial<PreviewTask> = {}): PreviewTask {
  return {
    task_id: "TASK-001",
    description: "Test task",
    assigned_to: "bot_0",
    complexity: "MEDIUM",
    dependencies: [],
    ...overrides,
  };
}

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
    ...overrides,
  } as GraphState;
}

// -----------------------------------------------------------------------
// Cost estimator tests
// -----------------------------------------------------------------------
describe("estimateCost", () => {
  it("returns zero for empty task list", () => {
    const result = estimateCost([]);
    expect(result.estimatedUSD).toBe(0);
    expect(result.parallelWaves).toBe(0);
    expect(result.rfcRequired).toBe(false);
    expect(result.estimatedMinutes).toBe(0);
  });

  it("calculates correct cost for simple tasks", () => {
    const tasks = [
      makeTask({ task_id: "t-1", complexity: "LOW" }),
      makeTask({ task_id: "t-2", complexity: "MEDIUM" }),
    ];
    const result = estimateCost(tasks);
    expect(result.estimatedUSD).toBe(0.04);
    expect(result.rfcRequired).toBe(false);
  });

  it("calculates correct cost for mixed simple and complex tasks", () => {
    const tasks = [
      makeTask({ task_id: "t-1", complexity: "LOW" }),
      makeTask({ task_id: "t-2", complexity: "MEDIUM" }),
      makeTask({ task_id: "t-3", complexity: "HIGH" }),
      makeTask({ task_id: "t-4", complexity: "ARCHITECTURE" }),
    ];
    const result = estimateCost(tasks);
    // 2 simple ($0.02 each) + 2 complex ($0.06 each)
    expect(result.estimatedUSD).toBe(0.16);
    expect(result.rfcRequired).toBe(true);
  });

  it("uses custom cost config", () => {
    const tasks = [makeTask({ complexity: "HIGH" })];
    const result = estimateCost(tasks, { costSimple: 0.05, costComplex: 0.10 });
    expect(result.estimatedUSD).toBe(0.10);
  });
});

describe("calculateWaves", () => {
  it("returns 0 for empty list", () => {
    expect(calculateWaves([])).toBe(0);
  });

  it("returns 1 for tasks with no dependencies", () => {
    const tasks = [
      makeTask({ task_id: "t-1" }),
      makeTask({ task_id: "t-2" }),
    ];
    expect(calculateWaves(tasks)).toBe(1);
  });

  it("calculates waves with linear dependencies", () => {
    const tasks = [
      makeTask({ task_id: "t-1", dependencies: [] }),
      makeTask({ task_id: "t-2", dependencies: ["t-1"] }),
      makeTask({ task_id: "t-3", dependencies: ["t-2"] }),
    ];
    expect(calculateWaves(tasks)).toBe(3);
  });

  it("calculates waves with parallel + sequential deps", () => {
    // t-1, t-2 parallel (wave 1), t-3 depends on both (wave 2)
    const tasks = [
      makeTask({ task_id: "t-1", dependencies: [] }),
      makeTask({ task_id: "t-2", dependencies: [] }),
      makeTask({ task_id: "t-3", dependencies: ["t-1", "t-2"] }),
    ];
    expect(calculateWaves(tasks)).toBe(2);
  });

  it("handles diamond dependency pattern", () => {
    // t-1 → t-2, t-3 → t-4
    const tasks = [
      makeTask({ task_id: "t-1", dependencies: [] }),
      makeTask({ task_id: "t-2", dependencies: ["t-1"] }),
      makeTask({ task_id: "t-3", dependencies: ["t-1"] }),
      makeTask({ task_id: "t-4", dependencies: ["t-2", "t-3"] }),
    ];
    expect(calculateWaves(tasks)).toBe(3);
  });
});

// -----------------------------------------------------------------------
// Preview node tests
// -----------------------------------------------------------------------
describe("createPreviewNode", () => {
  it("passes through when preview is already approved", async () => {
    const node = createPreviewNode();
    const state = makeState({
      preview: {
        tasks: [],
        estimate: { estimatedUSD: 0, parallelWaves: 0, rfcRequired: false, estimatedMinutes: 0 },
        status: "approved",
      } as unknown as Record<string, unknown>,
    });
    const result = await node(state);
    expect(result.__node__).toBe("preview_gate");
    expect(result.preview).toBeUndefined();
    expect(result.aborted).toBeUndefined();
  });

  it("auto-approves when skip_preview is true", async () => {
    const node = createPreviewNode();
    const state = makeState({
      skip_preview: true,
      task_queue: [
        { task_id: "T-1", description: "Test", assigned_to: "bot_0", status: "pending", complexity: "MEDIUM", dependencies: [] },
      ],
    });
    const result = await node(state);
    expect(result.__node__).toBe("preview_gate");
    const preview = result.preview as unknown as PreviewState;
    expect(preview.status).toBe("approved");
  });

  it("passes through when no pending tasks", async () => {
    const node = createPreviewNode();
    const state = makeState({ task_queue: [] });
    const result = await node(state);
    expect(result.__node__).toBe("preview_gate");
    expect(result.preview).toBeUndefined();
  });

  it("uses previewProvider when available (approve)", async () => {
    const provider = vi.fn().mockResolvedValue({ action: "approve" } as PreviewResponse);
    const node = createPreviewNode({ previewProvider: provider });
    const state = makeState({
      task_queue: [
        { task_id: "T-1", description: "Test task", assigned_to: "bot_0", status: "pending", complexity: "MEDIUM", dependencies: [] },
        { task_id: "T-2", description: "Another task", assigned_to: "bot_1", status: "pending", complexity: "HIGH", dependencies: ["T-1"] },
      ],
    });

    // Mock non-TTY to skip CLI prompts
    const origTTY = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as boolean;
    try {
      const result = await node(state);
      expect(provider).toHaveBeenCalledOnce();
      const preview = result.preview as unknown as PreviewState;
      expect(preview.status).toBe("approved");
      expect(preview.tasks).toHaveLength(2);
      expect(preview.estimate.estimatedUSD).toBeGreaterThan(0);
      expect(preview.estimate.parallelWaves).toBe(2);
      expect(result.aborted).toBeUndefined();
    } finally {
      process.stdout.isTTY = origTTY;
    }
  });

  it("sets aborted when provider returns abort", async () => {
    const provider = vi.fn().mockResolvedValue({ action: "abort" } as PreviewResponse);
    const node = createPreviewNode({ previewProvider: provider });
    const state = makeState({
      task_queue: [
        { task_id: "T-1", description: "Test", assigned_to: "bot_0", status: "pending", complexity: "LOW", dependencies: [] },
      ],
    });

    const origTTY = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as boolean;
    try {
      const result = await node(state);
      expect(result.aborted).toBe(true);
      const preview = result.preview as unknown as PreviewState;
      expect(preview.status).toBe("aborted");
    } finally {
      process.stdout.isTTY = origTTY;
    }
  });

  it("applies edited tasks when provider returns edit", async () => {
    const editedTasks: PreviewTask[] = [
      { task_id: "T-1", description: "Edited description", assigned_to: "bot_0", complexity: "MEDIUM", dependencies: [] },
    ];
    const provider = vi.fn().mockResolvedValue({
      action: "edit",
      editedTasks,
    } as PreviewResponse);

    const node = createPreviewNode({ previewProvider: provider });
    const state = makeState({
      task_queue: [
        { task_id: "T-1", description: "Original", assigned_to: "bot_0", status: "pending", complexity: "MEDIUM", dependencies: [] },
        { task_id: "T-2", description: "Removed", assigned_to: "bot_1", status: "pending", complexity: "LOW", dependencies: [] },
      ],
    });

    const origTTY = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as boolean;
    try {
      const result = await node(state);
      const preview = result.preview as unknown as PreviewState;
      expect(preview.status).toBe("edited");
      expect(preview.editedTasks).toHaveLength(1);
      // Task queue should only contain the edited task (T-2 was removed)
      const queue = result.task_queue as Record<string, unknown>[];
      expect(queue).toHaveLength(1);
      expect(queue[0].description).toBe("Edited description");
      expect(result.total_tasks).toBe(1);
    } finally {
      process.stdout.isTTY = origTTY;
    }
  });

  it("auto-approves in non-TTY without provider", async () => {
    const node = createPreviewNode();
    const state = makeState({
      task_queue: [
        { task_id: "T-1", description: "Test", assigned_to: "bot_0", status: "pending", complexity: "MEDIUM", dependencies: [] },
      ],
    });

    const origTTY = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as boolean;
    try {
      const result = await node(state);
      const preview = result.preview as unknown as PreviewState;
      expect(preview.status).toBe("approved");
    } finally {
      process.stdout.isTTY = origTTY;
    }
  });

  it("emits correct preview state with cost estimate", async () => {
    const provider = vi.fn().mockResolvedValue({ action: "approve" } as PreviewResponse);
    const node = createPreviewNode({ previewProvider: provider });
    const state = makeState({
      task_queue: [
        { task_id: "T-1", description: "Simple", assigned_to: "bot_0", status: "pending", complexity: "LOW", dependencies: [] },
        { task_id: "T-2", description: "Complex", assigned_to: "bot_1", status: "pending", complexity: "HIGH", dependencies: [] },
        { task_id: "T-3", description: "Arch", assigned_to: "bot_0", status: "pending", complexity: "ARCHITECTURE", dependencies: ["T-1", "T-2"] },
      ],
    });

    const origTTY = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as boolean;
    try {
      const result = await node(state);
      const preview = result.preview as unknown as PreviewState;
      expect(preview.tasks).toHaveLength(3);
      expect(preview.estimate.estimatedUSD).toBe(0.14); // 1 simple + 2 complex
      expect(preview.estimate.parallelWaves).toBe(2);
      expect(preview.estimate.rfcRequired).toBe(true);
    } finally {
      process.stdout.isTTY = origTTY;
    }
  });
});
