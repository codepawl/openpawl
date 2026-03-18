import { describe, it, expect } from "vitest";
import { Send } from "@langchain/langgraph";
import type { WorkerAdapter } from "@/adapters/worker-adapter.js";
import { WorkerBot, createTaskDispatcher, createWorkerCollectNode } from "@/agents/worker-bot.js";
import type { TaskRequest, TaskResult } from "@/core/state.js";
import type { GraphState } from "@/core/graph-state.js";

class StubAdapter implements WorkerAdapter {
  readonly adapterType = "provider" as const;
  readonly workerUrl = "http://stub";

  async executeTask(task: TaskRequest): Promise<TaskResult> {
    return { task_id: task.task_id, success: true, output: "ok", quality_score: 0.8 };
  }
  async healthCheck(): Promise<boolean> { return true; }
  async getStatus(): Promise<Record<string, unknown>> { return {}; }
  async reset(): Promise<void> {}
}

function makeBot(id: string): WorkerBot {
  return new WorkerBot(
    { id, name: id, role_id: "software_engineer", traits: {}, worker_url: null },
    new StubAdapter(),
  );
}

function makeState(tasks: Record<string, unknown>[], extra: Partial<GraphState> = {}): GraphState {
  return {
    task_queue: tasks,
    bot_stats: {},
    agent_messages: [],
    ...extra,
  } as GraphState;
}

describe("dependency-aware task dispatcher", () => {
  const workers = { bot_0: makeBot("bot_0"), bot_1: makeBot("bot_1"), bot_2: makeBot("bot_2"), bot_3: makeBot("bot_3") };
  const dispatcher = createTaskDispatcher(workers);

  it("dispatches all tasks immediately when no dependencies", () => {
    const state = makeState([
      { task_id: "TASK-001", assigned_to: "bot_0", status: "pending", description: "A", dependencies: [] },
      { task_id: "TASK-002", assigned_to: "bot_1", status: "pending", description: "B", dependencies: [] },
      { task_id: "TASK-003", assigned_to: "bot_2", status: "pending", description: "C", dependencies: [] },
    ]);
    const result = dispatcher(state);
    expect(Array.isArray(result)).toBe(true);
    expect((result as Send[]).length).toBe(3);
  });

  it("holds back tasks with unmet dependencies", () => {
    const state = makeState([
      { task_id: "TASK-001", assigned_to: "bot_0", status: "pending", description: "A", dependencies: [] },
      { task_id: "TASK-002", assigned_to: "bot_1", status: "pending", description: "B", dependencies: ["TASK-001"] },
    ]);
    const result = dispatcher(state);
    expect(Array.isArray(result)).toBe(true);
    const sends = result as Send[];
    expect(sends.length).toBe(1);
  });

  it("unblocks tasks when dependency completes", () => {
    const state = makeState([
      { task_id: "TASK-001", assigned_to: "bot_0", status: "completed", description: "A", dependencies: [], result: { quality_score: 0.9 } },
      { task_id: "TASK-002", assigned_to: "bot_1", status: "pending", description: "B", dependencies: ["TASK-001"] },
    ]);
    const result = dispatcher(state);
    expect(Array.isArray(result)).toBe(true);
    expect((result as Send[]).length).toBe(1);
  });

  it("treats failed dependency as terminal (unblocks downstream)", () => {
    const state = makeState([
      { task_id: "TASK-001", assigned_to: "bot_0", status: "failed", description: "A", dependencies: [], result: { quality_score: 0 } },
      { task_id: "TASK-002", assigned_to: "bot_1", status: "pending", description: "B", dependencies: ["TASK-001"] },
    ]);
    const result = dispatcher(state);
    expect(Array.isArray(result)).toBe(true);
    expect((result as Send[]).length).toBe(1);
  });

  it("handles diamond dependency graph across waves", () => {
    // Wave 1: only A is ready
    const wave1 = makeState([
      { task_id: "A", assigned_to: "bot_0", status: "pending", description: "A", dependencies: [] },
      { task_id: "B", assigned_to: "bot_1", status: "pending", description: "B", dependencies: ["A"] },
      { task_id: "C", assigned_to: "bot_2", status: "pending", description: "C", dependencies: ["A"] },
      { task_id: "D", assigned_to: "bot_3", status: "pending", description: "D", dependencies: ["B", "C"] },
    ]);
    const r1 = dispatcher(wave1);
    expect(Array.isArray(r1)).toBe(true);
    expect((r1 as Send[]).length).toBe(1);

    // Wave 2: A completed, B and C ready
    const wave2 = makeState([
      { task_id: "A", assigned_to: "bot_0", status: "completed", description: "A", dependencies: [], result: { quality_score: 0.9 } },
      { task_id: "B", assigned_to: "bot_1", status: "pending", description: "B", dependencies: ["A"] },
      { task_id: "C", assigned_to: "bot_2", status: "pending", description: "C", dependencies: ["A"] },
      { task_id: "D", assigned_to: "bot_3", status: "pending", description: "D", dependencies: ["B", "C"] },
    ]);
    const r2 = dispatcher(wave2);
    expect(Array.isArray(r2)).toBe(true);
    expect((r2 as Send[]).length).toBe(2);

    // Wave 3: A, B, C completed, D ready
    const wave3 = makeState([
      { task_id: "A", assigned_to: "bot_0", status: "completed", description: "A", dependencies: [], result: { quality_score: 0.9 } },
      { task_id: "B", assigned_to: "bot_1", status: "completed", description: "B", dependencies: ["A"], result: { quality_score: 0.9 } },
      { task_id: "C", assigned_to: "bot_2", status: "completed", description: "C", dependencies: ["A"], result: { quality_score: 0.9 } },
      { task_id: "D", assigned_to: "bot_3", status: "pending", description: "D", dependencies: ["B", "C"] },
    ]);
    const r3 = dispatcher(wave3);
    expect(Array.isArray(r3)).toBe(true);
    expect((r3 as Send[]).length).toBe(1);
  });

  it("returns worker_collect for circular dependencies (no deadlock)", () => {
    const state = makeState([
      { task_id: "A", assigned_to: "bot_0", status: "pending", description: "A", dependencies: ["B"] },
      { task_id: "B", assigned_to: "bot_1", status: "pending", description: "B", dependencies: ["A"] },
    ]);
    const result = dispatcher(state);
    expect(result).toBe("worker_collect");
  });

  it("dispatches tasks with no dependencies field (backward compatibility)", () => {
    const state = makeState([
      { task_id: "TASK-001", assigned_to: "bot_0", status: "pending", description: "A" },
      { task_id: "TASK-002", assigned_to: "bot_1", status: "pending", description: "B" },
    ]);
    const result = dispatcher(state);
    expect(Array.isArray(result)).toBe(true);
    expect((result as Send[]).length).toBe(2);
  });

  it("single task with no deps dispatches normally", () => {
    const state = makeState([
      { task_id: "TASK-001", assigned_to: "bot_0", status: "pending", description: "A", dependencies: [] },
    ]);
    const result = dispatcher(state);
    expect(Array.isArray(result)).toBe(true);
    expect((result as Send[]).length).toBe(1);
  });
});

describe("worker collect parallelism_depth", () => {
  it("increments parallelism_depth", () => {
    const collectNode = createWorkerCollectNode();
    const state = makeState(
      [{ task_id: "T1", status: "completed", result: { quality_score: 0.8 } }],
      { parallelism_depth: 2 } as Partial<GraphState>,
    );
    const result = collectNode(state);
    expect(result.parallelism_depth).toBe(3);
  });

  it("starts from 0 when parallelism_depth is undefined", () => {
    const collectNode = createWorkerCollectNode();
    const state = makeState([{ task_id: "T1", status: "completed", result: { quality_score: 0.8 } }]);
    const result = collectNode(state);
    expect(result.parallelism_depth).toBe(1);
  });
});
