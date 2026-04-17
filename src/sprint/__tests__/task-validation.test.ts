import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
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
  missingDescribedFiles(task: SprintTask): string[];
  state: { tasks: SprintTask[]; currentTaskIndex: number };
};

function internals(r: SprintRunner): RunnerInternals {
  return r as unknown as RunnerInternals;
}

describe("SprintRunner validation leniency fix", () => {
  it("taskDidWrite returns false for shell_exec only (shell_exec no longer counts as write)", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Create src/foo.ts with a greet function",
      status: "in_progress",
      toolsCalled: ["file_read", "file_list", "shell_exec", "shell_exec"],
    };
    expect(internals(runner).taskDidWrite(task)).toBe(false);
  });

  it("taskDidWrite returns true when file_write is among toolsCalled", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Create src/foo.ts",
      status: "in_progress",
      toolsCalled: ["file_read", "file_write"],
    };
    expect(internals(runner).taskDidWrite(task)).toBe(true);
  });

  it("taskExpectsWrite returns false for 'install dependencies' (dropped from keywords)", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Install dependencies with npm install",
      status: "in_progress",
    };
    expect(internals(runner).taskExpectsWrite(task)).toBe(false);
  });

  it("taskExpectsWrite returns false for 'run tests' (no write keyword)", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Run tests with vitest, verify all pass",
      status: "in_progress",
    };
    expect(internals(runner).taskExpectsWrite(task)).toBe(false);
  });

  it("taskExpectsWrite returns false for 'configure' and 'setup' alone (dropped from keywords)", () => {
    const runner = new SprintRunner(mockRegistry());
    const t1: SprintTask = { id: "a", description: "Configure eslint rules", status: "in_progress" };
    const t2: SprintTask = { id: "b", description: "Setup the CI pipeline", status: "in_progress" };
    expect(internals(runner).taskExpectsWrite(t1)).toBe(false);
    expect(internals(runner).taskExpectsWrite(t2)).toBe(false);
  });
});

describe("SprintRunner missingDescribedFiles", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "openpawl-missing-files-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when description mentions no file paths", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = { id: "t", description: "Do something abstract", status: "in_progress" };
    expect(internals(runner).missingDescribedFiles(task)).toEqual([]);
  });

  it("returns the missing path when task described creating a file that does not exist", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t",
      description: "Create src/foo.ts with a greet function",
      status: "in_progress",
    };
    const missing = internals(runner).missingDescribedFiles(task);
    expect(missing).toContain("src/foo.ts");
  });

  it("returns empty when the described file exists on disk", () => {
    mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    writeFileSync(path.join(tmpDir, "src", "foo.ts"), "export const x = 1;\n");
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t",
      description: "Create src/foo.ts with a greet function",
      status: "in_progress",
    };
    expect(internals(runner).missingDescribedFiles(task)).toEqual([]);
  });

  it("detects bare filenames like package.json and README.md", () => {
    writeFileSync(path.join(tmpDir, "package.json"), "{}\n");
    // README.md is intentionally NOT created
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t",
      description: "Update package.json and README.md with examples",
      status: "in_progress",
    };
    const missing = internals(runner).missingDescribedFiles(task);
    expect(missing).toEqual(["README.md"]);
  });
});

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
