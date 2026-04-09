import { describe, it, expect, vi } from "vitest";
import { SprintRunner } from "../../src/sprint/sprint-runner.js";
import type { SprintTask } from "../../src/sprint/types.js";

// Minimal mock agent registry
function mockRegistry() {
  return {
    get: (id: string) => ({
      id,
      name: id,
      description: `${id} agent`,
      capabilities: [],
      defaultTools: [],
      modelTier: "primary" as const,
      systemPrompt: `You are a ${id}.`,
      canCollaborate: false,
      maxConcurrent: 1,
    }),
    getAll: () => [],
    getIds: () => [],
    has: () => true,
  } as any;
}

describe("SprintRunner", () => {
  it("runs a sprint with 3 tasks", async () => {
    const runner = new SprintRunner(mockRegistry());
    let callCount = 0;
    (runner as any).runAgent = vi.fn(async (): Promise<string> => {
      callCount++;
      if (callCount === 1) {
        // Planner response
        return "1. Design the schema\n2. Implement the API\n3. Write tests";
      }
      return "Completed task successfully.";
    });

    const events: string[] = [];
    runner.on("sprint:start", () => events.push("start"));
    runner.on("sprint:plan", () => events.push("plan"));
    runner.on("sprint:task:start", () => events.push("task:start"));
    runner.on("sprint:task:complete", () => events.push("task:complete"));
    runner.on("sprint:done", () => events.push("done"));

    const result = await runner.run("Build a REST API");

    expect(result.completedTasks).toBe(3);
    expect(result.failedTasks).toBe(0);
    expect(result.tasks).toHaveLength(3);

    expect(events).toEqual([
      "start", "plan",
      "task:start", "task:complete",
      "task:start", "task:complete",
      "task:start", "task:complete",
      "done",
    ]);
  });

  it("handles task failure gracefully", async () => {
    const runner = new SprintRunner(mockRegistry());
    let callCount = 0;
    (runner as any).runAgent = vi.fn(async (): Promise<string> => {
      callCount++;
      if (callCount === 1) return "1. Do something";
      throw new Error("LLM timeout");
    });

    const result = await runner.run("Failing goal");

    expect(result.completedTasks).toBe(0);
    expect(result.failedTasks).toBe(1);
    expect(result.tasks[0]!.status).toBe("failed");
    expect(result.tasks[0]!.error).toBe("LLM timeout");
  });

  it("can be stopped mid-sprint", async () => {
    const runner = new SprintRunner(mockRegistry());
    let callCount = 0;
    (runner as any).runAgent = vi.fn(async (): Promise<string> => {
      callCount++;
      if (callCount === 1) return "1. Task A\n2. Task B\n3. Task C";
      if (callCount === 2) {
        // Stop after first task executes
        runner.stop();
        return "Done A";
      }
      return "Done";
    });

    const result = await runner.run("Stoppable goal");

    // Should have completed 1 task, then stopped
    expect(result.completedTasks).toBe(1);
    expect(result.tasks.filter(t => t.status === "pending").length).toBeGreaterThan(0);
  });

  it("assigns agents based on task description keywords", () => {
    const runner = new SprintRunner(mockRegistry());
    const assign = (runner as any).assignAgent.bind(runner);

    const testTask: SprintTask = { id: "1", description: "Write unit tests for auth", status: "pending" };
    const codeTask: SprintTask = { id: "2", description: "Create user model", status: "pending" };
    const reviewTask: SprintTask = { id: "3", description: "Review the pull request", status: "pending" };
    const debugTask: SprintTask = { id: "4", description: "Debug the login bug", status: "pending" };

    expect(assign(testTask)).toBe("tester");
    expect(assign(codeTask)).toBe("coder");
    expect(assign(reviewTask)).toBe("reviewer");
    expect(assign(debugTask)).toBe("debugger");
  });
});
