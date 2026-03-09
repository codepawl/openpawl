import { describe, it, expect, vi } from "vitest";
import {
  WorkerBot,
  createWorkerBots,
  createWorkerExecuteNode,
} from "../src/agents/worker-bot.js";
import type { WorkerAdapter } from "../src/interfaces/worker-adapter.js";
import type { TaskRequest, TaskResult } from "../src/core/state.js";
import type { GraphState } from "../src/core/graph-state.js";

function createMockAdapter(result: TaskResult): WorkerAdapter {
  return {
    adapterType: "openclaw",
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

describe("createWorkerExecuteNode", () => {
  it("processes pending task and updates queue and bot_stats", async () => {
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

    const node = createWorkerExecuteNode({ bot_0: workerBot });
    const state: GraphState = {
      task_queue: [
        {
          task_id: "TASK-001",
          assigned_to: "bot_0",
          status: "pending",
          description: "Build feature",
          priority: "MEDIUM",
          result: null,
        },
      ],
      bot_stats: { bot_0: { tasks_completed: 0, tasks_failed: 0 } },
      agent_messages: [],
    } as GraphState;

    const out = await node(state);

    expect(out.task_queue).toBeDefined();
    const q = out.task_queue as Array<{ status: string; result: TaskResult }>;
    expect(q[0].status).toBe("completed");
    expect(q[0].result?.success).toBe(true);

    expect(out.bot_stats).toBeDefined();
    expect((out.bot_stats as Record<string, { tasks_completed: number }>)["bot_0"].tasks_completed).toBe(1);

    expect(out.__node__).toBe("worker_execute");
  });

  it("marks task failed when worker returns success false", async () => {
    const result: TaskResult = {
      task_id: "TASK-002",
      success: false,
      output: "Failed",
      quality_score: 0.2,
    };
    const mockAdapter = createMockAdapter(result);
    const workerBot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {} },
      mockAdapter
    );

    const node = createWorkerExecuteNode({ bot_0: workerBot });
    const state: GraphState = {
      task_queue: [
        {
          task_id: "TASK-002",
          assigned_to: "bot_0",
          status: "pending",
          description: "Fix bug",
          priority: "HIGH",
          result: null,
        },
      ],
      bot_stats: { bot_0: { tasks_completed: 0, tasks_failed: 0 } },
      agent_messages: [],
    } as GraphState;

    const out = await node(state);

    const q = out.task_queue as Array<{ status: string; result: TaskResult }>;
    expect(q[0].status).toBe("failed");
    expect(q[0].result?.success).toBe(false);
    expect((out.bot_stats as Record<string, { tasks_failed: number }>)["bot_0"].tasks_failed).toBe(1);
  });

  it("returns early when no pending tasks", async () => {
    const node = createWorkerExecuteNode({});
    const state: GraphState = {
      task_queue: [
        {
          task_id: "TASK-001",
          assigned_to: "bot_0",
          status: "completed",
          description: "Done",
          priority: "MEDIUM",
          result: {},
        },
      ],
      bot_stats: {},
      agent_messages: [],
    } as GraphState;

    const out = await node(state);

    expect(out.last_action).toBe("No pending tasks");
    expect(out.task_queue).toBeUndefined();
  });

  it("marks task failed when healthCheck returns false", async () => {
    const result: TaskResult = {
      task_id: "TASK-001",
      success: false,
      output: "Unreachable",
      quality_score: 0,
    };
    const mockAdapter = createMockAdapter(result);
    mockAdapter.healthCheck = vi.fn(() => Promise.resolve(false));
    const workerBot = new WorkerBot(
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {} },
      mockAdapter
    );

    const node = createWorkerExecuteNode({ bot_0: workerBot });
    const state: GraphState = {
      task_queue: [
        {
          task_id: "TASK-001",
          assigned_to: "bot_0",
          status: "pending",
          description: "Task",
          priority: "MEDIUM",
          result: null,
        },
      ],
      bot_stats: { bot_0: { tasks_completed: 0, tasks_failed: 0 } },
      agent_messages: [],
    } as GraphState;

    const out = await node(state);

    const q = out.task_queue as Array<{ status: string; result: { output: string } }>;
    expect(q[0].status).toBe("failed");
    expect(q[0].result?.output).toContain("unreachable");
    expect(mockAdapter.executeTask).not.toHaveBeenCalled();
  });

  it("marks task failed when worker not found", async () => {
    const node = createWorkerExecuteNode({});
    const state: GraphState = {
      task_queue: [
        {
          task_id: "TASK-001",
          assigned_to: "missing_bot",
          status: "pending",
          description: "Task",
          priority: "MEDIUM",
          result: null,
        },
      ],
      bot_stats: {},
      agent_messages: [],
    } as GraphState;

    const out = await node(state);

    const q = out.task_queue as Array<{ status: string; result: { success: boolean } }>;
    expect(q[0].status).toBe("failed");
    expect(q[0].result?.success).toBe(false);
    expect(String(out.last_action)).toContain("Dispatched");
  });
});
