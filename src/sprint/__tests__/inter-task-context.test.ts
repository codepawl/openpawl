import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKnownFilesBlock } from "../sprint-runner.js";
import type { SprintState, SprintTask } from "../types.js";

let cwd: string;

function task(id: string, description: string, status: SprintTask["status"] = "completed"): SprintTask {
  return { id, description, status };
}

function state(tasks: SprintTask[]): SprintState {
  return {
    goal: "build",
    tasks,
    currentTaskIndex: tasks.length,
    phase: "executing",
    startedAt: new Date().toISOString(),
    completedTasks: tasks.filter((t) => t.status === "completed").length,
    failedTasks: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "sprint-known-files-"));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "src/commands"), { recursive: true });
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("buildKnownFilesBlock — inter-task context sharing", () => {
  it("empty when no prior tasks exist", () => {
    const s = state([task("t1", "Create src/types.ts with Task interface", "pending")]);
    expect(buildKnownFilesBlock(s, cwd)).toBe("");
  });

  it("empty when prior tasks completed but their files are not on disk", () => {
    const s = state([task("t1", "Create src/missing.ts with a helper")]);
    expect(buildKnownFilesBlock(s, cwd)).toBe("");
  });

  it("lists the file written by a prior task", () => {
    writeFileSync(join(cwd, "src/types.ts"), "export interface Task {}\n");
    const s = state([
      task("t1", "Create src/types.ts with Task interface containing id, title, priority"),
      task("t2", "Create src/storage.ts with load/save helpers", "pending"),
    ]);
    const block = buildKnownFilesBlock(s, cwd);
    expect(block).toContain("Files already created");
    expect(block).toContain("src/types.ts");
    expect(block).toContain("Task interface");
  });

  it("block only appears when at least one prior completed task has an on-disk file", () => {
    writeFileSync(join(cwd, "src/types.ts"), "x");
    const s = state([
      task("t1", "Create src/types.ts with Task interface"),
    ]);
    expect(buildKnownFilesBlock(s, cwd)).not.toBe("");
  });

  it("stays within 500-char budget regardless of prior task count", () => {
    writeFileSync(join(cwd, "src/types.ts"), "x");
    writeFileSync(join(cwd, "src/storage.ts"), "x");
    writeFileSync(join(cwd, "src/display.ts"), "x");
    writeFileSync(join(cwd, "src/cli.ts"), "x");
    writeFileSync(join(cwd, "src/index.ts"), "x");
    writeFileSync(join(cwd, "src/commands/add.ts"), "x");
    writeFileSync(join(cwd, "src/commands/complete.ts"), "x");
    writeFileSync(join(cwd, "src/commands/list.ts"), "x");
    writeFileSync(join(cwd, "src/commands/delete.ts"), "x");

    const LONG = " additional descriptive text ".repeat(10);
    const tasks = [
      task("t1", "Create src/types.ts with Task interface" + LONG),
      task("t2", "Create src/storage.ts with load/save helpers" + LONG),
      task("t3", "Create src/display.ts with formatter" + LONG),
      task("t4", "Create src/cli.ts with argument parser" + LONG),
      task("t5", "Create src/index.ts as entry point" + LONG),
      task("t6", "Create src/commands/add.ts" + LONG),
      task("t7", "Create src/commands/complete.ts" + LONG),
      task("t8", "Create src/commands/list.ts" + LONG),
      task("t9", "Create src/commands/delete.ts" + LONG),
    ];
    const block = buildKnownFilesBlock(state(tasks), cwd);
    // The leading "\n\n" is outside the budget; we bound the header+list body.
    const body = block.replace(/^\n\n/, "");
    expect(body.length).toBeLessThanOrEqual(500 + 20); // "…+N more" appendix slack
    expect(block).toContain("…+");
  });

  it("skips files that only a failed task referenced (status filter)", () => {
    writeFileSync(join(cwd, "src/cli.ts"), "x");
    const s = state([
      { ...task("t1", "Create src/cli.ts with parser"), status: "failed" },
      task("t2", "Create src/index.ts", "pending"),
    ]);
    expect(buildKnownFilesBlock(s, cwd)).toBe("");
  });

  it("dedupes when the same file is mentioned by multiple completed tasks", () => {
    writeFileSync(join(cwd, "src/types.ts"), "x");
    const s = state([
      task("t1", "Create src/types.ts with Task interface"),
      task("t2", "Extend src/types.ts with extra fields"),
    ]);
    const block = buildKnownFilesBlock(s, cwd);
    // Exactly one bullet entry — dedupe by path
    const bullets = block.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(1);
    expect(bullets[0]).toContain("src/types.ts");
  });
});
