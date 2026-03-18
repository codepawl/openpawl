import { describe, it, expect } from "vitest";
import { Send } from "@langchain/langgraph";
import type { WorkerAdapter } from "@/adapters/worker-adapter.js";
import { resolveTargetUrl } from "@/adapters/worker-adapter.js";
import { WorkerBot, createTaskDispatcher, createWorkerTaskNode } from "@/agents/worker-bot.js";
import type { TaskRequest, TaskResult } from "@/core/state.js";
import type { GraphState } from "@/core/graph-state.js";

class TimedMockAdapter implements WorkerAdapter {
  readonly adapterType = "provider" as const;
  readonly workerUrl: string;
  private readonly delayMs: number;
  private readonly activeByUrl: Map<string, number>;
  private readonly overlapByUrl: Set<string>;

  constructor(opts: {
    workerUrl: string;
    delayMs: number;
    activeByUrl: Map<string, number>;
    overlapByUrl: Set<string>;
  }) {
    this.workerUrl = opts.workerUrl;
    this.delayMs = opts.delayMs;
    this.activeByUrl = opts.activeByUrl;
    this.overlapByUrl = opts.overlapByUrl;
  }

  async executeTask(task: TaskRequest): Promise<TaskResult> {
    const current = this.activeByUrl.get(this.workerUrl) ?? 0;
    this.activeByUrl.set(this.workerUrl, current + 1);
    if ((this.activeByUrl.get(this.workerUrl) ?? 0) > 1) {
      this.overlapByUrl.add(this.workerUrl);
    }
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.activeByUrl.set(this.workerUrl, (this.activeByUrl.get(this.workerUrl) ?? 1) - 1);
    return {
      task_id: task.task_id,
      success: true,
      output: `ok:${task.task_id}`,
      quality_score: 0.9,
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  async reset(): Promise<void> {
    return;
  }
}

describe("resolveTargetUrl", () => {
  it("resolves role-label mapping with fallback", () => {
    const url = resolveTargetUrl(
      {
        id: "bot_7",
        name: "Backend Coder 1",
        role_id: "custom_backend_coder",
        worker_url: null,
        traits: { role_label: "Backend Coder" },
      },
      {
        "role:Backend Coder": "http://localhost:8002",
      },
      "http://localhost:8001",
    );
    expect(url).toBe("http://localhost:8002");
  });
});

describe("createTaskDispatcher", () => {
  it("returns Send[] for pending tasks assigned to correct bots", () => {
    const makeBot = (id: string, name: string, url: string) =>
      new WorkerBot(
        { id, name, role_id: "software_engineer", traits: {}, worker_url: null },
        new TimedMockAdapter({ workerUrl: url, delayMs: 0, activeByUrl: new Map(), overlapByUrl: new Set() }),
      );

    const workers = {
      bot_0: makeBot("bot_0", "Frontend", "http://localhost:8001"),
      bot_1: makeBot("bot_1", "Backend", "http://localhost:8001"),
      bot_2: makeBot("bot_2", "Designer", "http://localhost:8002"),
    };

    const dispatcher = createTaskDispatcher(workers);
    const state = {
      task_queue: [
        { task_id: "TASK-001", assigned_to: "bot_0", status: "pending", description: "A", priority: "MEDIUM", result: null },
        { task_id: "TASK-002", assigned_to: "bot_1", status: "pending", description: "B", priority: "MEDIUM", result: null },
        { task_id: "TASK-003", assigned_to: "bot_2", status: "pending", description: "C", priority: "MEDIUM", result: null },
      ],
      bot_stats: {},
      agent_messages: [],
    } as GraphState;

    const result = dispatcher(state);
    expect(Array.isArray(result)).toBe(true);
    const sends = result as Send[];
    expect(sends).toHaveLength(3);
    // Each Send should be a Send instance
    for (const send of sends) {
      expect(send).toBeInstanceOf(Send);
    }
  });
});

describe("parallel worker_task execution", () => {
  it("processes tasks independently via worker_task nodes", async () => {
    const activeByUrl = new Map<string, number>();
    const overlapByUrl = new Set<string>();

    const makeBot = (id: string, name: string, url: string) =>
      new WorkerBot(
        { id, name, role_id: "software_engineer", traits: {}, worker_url: null },
        new TimedMockAdapter({ workerUrl: url, delayMs: 30, activeByUrl, overlapByUrl }),
      );

    const workers = {
      bot_0: makeBot("bot_0", "Frontend", "http://localhost:8001"),
      bot_1: makeBot("bot_1", "Backend", "http://localhost:8001"),
      bot_2: makeBot("bot_2", "Designer", "http://localhost:8002"),
    };

    const taskNode = createWorkerTaskNode(workers);

    // Simulate parallel execution by running tasks concurrently
    const tasks = [
      { task_id: "TASK-001", assigned_to: "bot_0", status: "pending", description: "A", priority: "MEDIUM", result: null },
      { task_id: "TASK-002", assigned_to: "bot_1", status: "pending", description: "B", priority: "MEDIUM", result: null },
      { task_id: "TASK-003", assigned_to: "bot_2", status: "pending", description: "C", priority: "MEDIUM", result: null },
    ];

    const results = await Promise.all(
      tasks.map((task) =>
        taskNode({
          _send_task: task,
          _send_bot_id: task.assigned_to,
          task_queue: tasks as Record<string, unknown>[],
          bot_stats: {},
          agent_messages: [],
        } as unknown as GraphState)
      )
    );

    // All tasks should have completed
    for (const out of results) {
      const q = out.task_queue as Array<{ status: string }>;
      expect(q).toHaveLength(1);
      expect(q[0].status).toBe("completed");
    }
    expect(results).toHaveLength(3);
  });
});
