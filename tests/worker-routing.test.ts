import { describe, it, expect } from "vitest";
import type { WorkerAdapter } from "../src/interfaces/worker-adapter.js";
import { resolveTargetUrl } from "../src/interfaces/worker-adapter.js";
import { WorkerBot, createWorkerExecuteNode } from "../src/agents/worker-bot.js";
import type { TaskRequest, TaskResult } from "../src/core/state.js";
import type { GraphState } from "../src/core/graph-state.js";

class TimedMockAdapter implements WorkerAdapter {
  readonly adapterType = "openclaw" as const;
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

describe("grouped dispatcher", () => {
  it("runs same-url tasks sequentially and different-url tasks in parallel", async () => {
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

    const node = createWorkerExecuteNode(workers);
    const out = await node({
      task_queue: [
        {
          task_id: "TASK-001",
          assigned_to: "bot_0",
          status: "pending",
          description: "A",
          priority: "MEDIUM",
          result: null,
        },
        {
          task_id: "TASK-002",
          assigned_to: "bot_1",
          status: "pending",
          description: "B",
          priority: "MEDIUM",
          result: null,
        },
        {
          task_id: "TASK-003",
          assigned_to: "bot_2",
          status: "pending",
          description: "C",
          priority: "MEDIUM",
          result: null,
        },
      ],
      bot_stats: {
        bot_0: { tasks_completed: 0, tasks_failed: 0 },
        bot_1: { tasks_completed: 0, tasks_failed: 0 },
        bot_2: { tasks_completed: 0, tasks_failed: 0 },
      },
      agent_messages: [],
    } as GraphState);

    const queue = out.task_queue as Array<{ status: string }>;
    expect(queue.every((q) => q.status === "completed")).toBe(true);
    expect(overlapByUrl.has("http://localhost:8001")).toBe(false);
  });
});
