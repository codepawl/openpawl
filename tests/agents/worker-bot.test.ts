import { describe, it, expect, vi } from "vitest";
import { Send } from "@langchain/langgraph";
import {
  WorkerBot,
  createWorkerBots,
  createTaskDispatcher,
  createWorkerTaskNode,
  createWorkerCollectNode,
} from "@/agents/worker-bot.js";
import type { WorkerAdapter } from "@/interfaces/worker-adapter.js";
import type { TaskRequest, TaskResult } from "@/core/state.js";
import type { GraphState } from "@/core/graph-state.js";

function createMockAdapter(result: TaskResult): WorkerAdapter {
  return {
    adapterType: "provider",
    executeTask: vi.fn(() => Promise.resolve(result)),
    healthCheck: vi.fn(() => Promise.resolve(true)),
    getStatus: vi.fn(() => Promise.resolve({})),
    reset: vi.fn(() => Promise.resolve()),
  };
}

describe("WorkerBot", () => {
  it("executeTask delegates to adapter and returns result", async () => {
    const result: TaskResult = {
      task_id: "TASK-001",
      success: true,
      output: "Done",
      quality_score: 0.9,
    };
    const mockAdapter = createMockAdapter(result);
    const bot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {} },
      mockAdapter
    );

    const out = await bot.executeTask({
      task_id: "TASK-001",
      description: "Build feature",
    });

    expect(mockAdapter.executeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "TASK-001",
        description: "Build feature",
      })
    );
    expect(out).toEqual(result);
  });

  it("executeTask with worker_tier heavy and unhealthy heavyAdapter returns FAILED without calling heavy", async () => {
    const lightAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: true,
      output: "fallback",
      quality_score: 0.5,
    });
    const heavyAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: true,
      output: "heavy done",
      quality_score: 0.9,
    });
    heavyAdapter.healthCheck = vi.fn(() => Promise.resolve(false));

    const bot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {} },
      lightAdapter,
      heavyAdapter
    );

    const out = await bot.executeTask(
      { task_id: "TASK-001", description: "Click login in browser" },
      { worker_tier: "heavy" }
    );

    expect(out.success).toBe(false);
    expect(out.output).toContain("OpenClaw required but service unavailable");
    expect(out.quality_score).toBe(0);
    expect(heavyAdapter.executeTask).not.toHaveBeenCalled();
    expect(lightAdapter.executeTask).not.toHaveBeenCalled();
  });
});

describe("createTaskDispatcher", () => {
  it("returns Send[] with correct payloads for pending tasks", () => {
    const mockAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: true,
      output: "done",
      quality_score: 0.9,
    });
    const workerBot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {} },
      mockAdapter
    );

    const team = [
      { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {} },
    ];
    const dispatcher = createTaskDispatcher({ bot_0: workerBot }, team);
    const state = {
      task_queue: [
        { task_id: "TASK-001", assigned_to: "bot_0", status: "pending", description: "Build feature" },
        { task_id: "TASK-002", assigned_to: "bot_0", status: "pending", description: "Fix bug" },
      ],
    } as GraphState;

    const result = dispatcher(state);
    expect(Array.isArray(result)).toBe(true);
    const sends = result as Send[];
    expect(sends).toHaveLength(2);
    expect(sends[0]).toBeInstanceOf(Send);
  });

  it("returns 'worker_collect' when no actionable tasks", () => {
    const dispatcher = createTaskDispatcher({});
    const state = {
      task_queue: [
        { task_id: "TASK-001", status: "completed", description: "Done" },
      ],
    } as GraphState;

    const result = dispatcher(state);
    expect(result).toBe("worker_collect");
  });

  it("assigns reviewer bot for reviewing tasks", () => {
    const makerAdapter = createMockAdapter({ task_id: "TASK-001", success: true, output: "done", quality_score: 0.9 });
    const reviewerAdapter = createMockAdapter({ task_id: "TASK-001", success: true, output: "APPROVED", quality_score: 0.9 });
    const makerBot = new WorkerBot({ id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {} }, makerAdapter);
    const reviewerBot = new WorkerBot({ id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {} }, reviewerAdapter);

    const team = [
      { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {} },
      { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {} },
    ];
    const dispatcher = createTaskDispatcher({ bot_0: makerBot, bot_1: reviewerBot }, team);
    const state = {
      task_queue: [
        { task_id: "TASK-001", assigned_to: "bot_0", status: "reviewing", description: "Review this" },
      ],
    } as GraphState;

    const result = dispatcher(state) as Send[];
    expect(result).toHaveLength(1);
    // The Send should target bot_1 (reviewer)
    expect((result[0] as unknown as { args: Record<string, unknown> }).args._send_bot_id).toBe("bot_1");
  });
});

describe("createWorkerTaskNode", () => {
  it("processes a single pending task and returns partial state", async () => {
    const result: TaskResult = {
      task_id: "TASK-001",
      success: true,
      output: "Implemented feature",
      quality_score: 0.85,
    };
    const mockAdapter = createMockAdapter(result);
    const workerBot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {} },
      mockAdapter
    );

    const node = createWorkerTaskNode({ bot_0: workerBot });
    const state = {
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_0",
        status: "pending",
        description: "Build feature",
        priority: "MEDIUM",
        result: null,
      },
      _send_bot_id: "bot_0",
      task_queue: [],
      bot_stats: {},
      agent_messages: [],
    } as unknown as GraphState;

    const out = await node(state);

    expect(out.task_queue).toBeDefined();
    const q = out.task_queue as Array<{ status: string; result: TaskResult }>;
    expect(q).toHaveLength(1);
    expect(q[0].status).toBe("completed");
    expect(q[0].result?.success).toBe(true);
    expect(out.__node__).toBe("worker_task");
  });

  it("never throws even on adapter crash", async () => {
    const mockAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: false,
      output: "error",
      quality_score: 0,
    });
    mockAdapter.healthCheck = vi.fn(() => Promise.reject(new Error("CRASH")));
    const workerBot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {} },
      mockAdapter
    );

    const node = createWorkerTaskNode({ bot_0: workerBot });
    const state = {
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_0",
        status: "pending",
        description: "Task",
        priority: "MEDIUM",
        result: null,
      },
      _send_bot_id: "bot_0",
      task_queue: [],
      bot_stats: {},
      agent_messages: [],
    } as unknown as GraphState;

    // Should NOT throw
    const out = await node(state);
    expect(out.__node__).toBe("worker_task");
    const q = out.task_queue as Array<{ status: string }>;
    expect(q[0].status).toBe("failed");
  });

  it("returns delta bot_stats (not absolute)", async () => {
    const result: TaskResult = {
      task_id: "TASK-001",
      success: true,
      output: "Done",
      quality_score: 0.9,
    };
    const mockAdapter = createMockAdapter(result);
    const workerBot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {} },
      mockAdapter
    );

    // No team = no reviewer, so success → completed with delta stats
    const node = createWorkerTaskNode({ bot_0: workerBot });
    const state = {
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_0",
        status: "pending",
        description: "Build feature",
        priority: "MEDIUM",
        result: null,
      },
      _send_bot_id: "bot_0",
      task_queue: [],
      bot_stats: {},
      agent_messages: [],
    } as unknown as GraphState;

    const out = await node(state);
    const stats = out.bot_stats as Record<string, Record<string, number>>;
    // Delta: tasks_completed = 1, not an absolute count
    expect(stats.bot_0.tasks_completed).toBe(1);
  });

  it("marks task failed when healthCheck returns false", async () => {
    const mockAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: false,
      output: "Unreachable",
      quality_score: 0,
    });
    mockAdapter.healthCheck = vi.fn(() => Promise.resolve(false));
    const workerBot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {} },
      mockAdapter
    );

    const node = createWorkerTaskNode({ bot_0: workerBot });
    const state = {
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_0",
        status: "pending",
        description: "Task",
        priority: "MEDIUM",
        result: null,
      },
      _send_bot_id: "bot_0",
      task_queue: [],
      bot_stats: {},
      agent_messages: [],
    } as unknown as GraphState;

    const out = await node(state);

    const q = out.task_queue as Array<{ status: string; result: { output: string } }>;
    expect(q[0].status).toBe("failed");
    expect(q[0].result?.output).toContain("unreachable");
    expect(mockAdapter.executeTask).not.toHaveBeenCalled();
  });

  it("marks task failed when worker not found", async () => {
    const node = createWorkerTaskNode({});
    const state = {
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "missing_bot",
        status: "pending",
        description: "Task",
        priority: "MEDIUM",
        result: null,
      },
      _send_bot_id: "missing_bot",
      task_queue: [],
      bot_stats: {},
      agent_messages: [],
    } as unknown as GraphState;

    const out = await node(state);

    const q = out.task_queue as Array<{ status: string; result: { success: boolean } }>;
    expect(q[0].status).toBe("failed");
    expect(q[0].result?.success).toBe(false);
  });
});

describe("createWorkerCollectNode", () => {
  it("computes average quality score from task results", () => {
    const node = createWorkerCollectNode();
    const state = {
      task_queue: [
        {
          task_id: "TASK-001",
          status: "completed",
          result: { task_id: "TASK-001", success: true, output: "done", quality_score: 0.8 },
        },
        {
          task_id: "TASK-002",
          status: "completed",
          result: { task_id: "TASK-002", success: true, output: "done", quality_score: 0.6 },
        },
      ],
      bot_stats: {},
    } as unknown as GraphState;

    const out = node(state);

    expect(out.__node__).toBe("worker_collect");
    expect(out.last_quality_score).toBe(70); // (0.8+0.6)/2 * 100
    expect(out.deep_work_mode).toBe(true);
  });

  it("returns 0 quality when no tasks have results", () => {
    const node = createWorkerCollectNode();
    const state = {
      task_queue: [
        { task_id: "TASK-001", status: "pending", result: null },
      ],
    } as unknown as GraphState;

    const out = node(state);
    expect(out.last_quality_score).toBe(0);
  });
});
