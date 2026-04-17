import { describe, it, expect } from "bun:test";
import { SprintRunner } from "../sprint-runner.js";
import type { SprintTask } from "../types.js";

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
  } as unknown as ConstructorParameters<typeof SprintRunner>[0];
}

/**
 * Access private helpers on the runner for direct testing, without having
 * to go through a full sprint run.
 */
type RunnerInternals = {
  taskDidWrite(task: SprintTask): boolean;
  taskExpectsWrite(task: SprintTask): boolean;
  state: { tasks: SprintTask[]; currentTaskIndex: number };
};

function internals(r: SprintRunner): RunnerInternals {
  return r as unknown as RunnerInternals;
}

describe("SprintRunner validation helpers", () => {
  it("taskDidWrite returns true when file_write is in toolsCalled", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Create and install X",
      status: "in_progress",
      toolsCalled: ["file_read", "file_write", "file_write"],
    };
    expect(internals(runner).taskDidWrite(task)).toBe(true);
  });

  it("taskDidWrite returns false when only read tools were called", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Add feature X",
      status: "in_progress",
      toolsCalled: ["file_read", "file_list"],
    };
    expect(internals(runner).taskDidWrite(task)).toBe(false);
  });

  it("taskExpectsWrite returns false for a read-only description", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Read and report the codebase structure",
      status: "in_progress",
    };
    expect(internals(runner).taskExpectsWrite(task)).toBe(false);
  });
});

describe("SprintRunner.recordToolCall — parallel attribution", () => {
  it("attributes to the explicit taskIndex, not state.currentTaskIndex", () => {
    const runner = new SprintRunner(mockRegistry());
    // Populate state with two in-progress tasks
    const taskA: SprintTask = { id: "a", description: "create A", status: "in_progress" };
    const taskB: SprintTask = { id: "b", description: "create B", status: "in_progress" };
    internals(runner).state.tasks = [taskA, taskB];

    // Simulate the race: currentTaskIndex points at B, but the tool call
    // originated from A (explicit taskIndex = 0).
    internals(runner).state.currentTaskIndex = 1;
    runner.recordToolCall("file_write", undefined, 0);

    // And a write from B
    runner.recordToolCall("file_edit", undefined, 1);

    expect(taskA.toolsCalled).toEqual(["file_write"]);
    expect(taskB.toolsCalled).toEqual(["file_edit"]);
    expect(taskA.toolsCalled).not.toContain("file_edit");
    expect(taskB.toolsCalled).not.toContain("file_write");
  });

  it("falls back to currentTaskIndex when taskIndex is omitted", () => {
    const runner = new SprintRunner(mockRegistry());
    const taskA: SprintTask = { id: "a", description: "x", status: "in_progress" };
    const taskB: SprintTask = { id: "b", description: "y", status: "in_progress" };
    internals(runner).state.tasks = [taskA, taskB];
    internals(runner).state.currentTaskIndex = 1;

    runner.recordToolCall("file_write");

    expect(taskB.toolsCalled).toContain("file_write");
    expect(taskA.toolsCalled ?? []).not.toContain("file_write");
  });

  it("preserves exitCode and stderrHead in toolCallResults", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = { id: "t", description: "x", status: "in_progress" };
    internals(runner).state.tasks = [task];

    runner.recordToolCall("shell_exec", { exitCode: 127, stderrHead: "nope" }, 0);

    expect(task.toolCallResults).toEqual([
      { name: "shell_exec", exitCode: 127, stderrHead: "nope" },
    ]);
  });

  it("no-ops when the addressed task is not in_progress", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = { id: "t", description: "x", status: "completed" };
    internals(runner).state.tasks = [task];

    runner.recordToolCall("file_write", undefined, 0);

    expect(task.toolsCalled).toBeUndefined();
  });
});
