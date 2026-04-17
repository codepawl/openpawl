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

function makeTask(overrides: Partial<SprintTask> = {}): SprintTask {
  return {
    id: "t1",
    description: "do stuff",
    status: "failed",
    ...overrides,
  };
}

/** Expose the private isRetriable for direct testing. */
function isRetriable(task: SprintTask): boolean {
  const runner = new SprintRunner(mockRegistry());
  return (runner as unknown as { isRetriable(t: SprintTask): boolean }).isRetriable(task);
}

describe("SprintRunner.isRetriable", () => {
  it("does not retry when last shell_exec call failed with exit 127", () => {
    const task = makeTask({
      error: "generic error",
      toolCallResults: [
        { name: "shell_exec", exitCode: 127, stderrHead: "npm: command not found" },
      ],
    });
    expect(isRetriable(task)).toBe(false);
  });

  it("does not retry on timeout errors (preserved fallback)", () => {
    const task = makeTask({ error: "timed out after 30s" });
    expect(isRetriable(task)).toBe(false);
  });

  it("retries on agent-logic errors (TypeError)", () => {
    const task = makeTask({ error: "TypeError: foo is not a function" });
    expect(isRetriable(task)).toBe(true);
  });

  it("retries when error is empty and no tool results are present", () => {
    const task = makeTask({ error: undefined });
    expect(isRetriable(task)).toBe(true);
  });

  it("does not retry when task was aborted", () => {
    const task = makeTask({ error: "aborted by user" });
    expect(isRetriable(task)).toBe(false);
  });

  it("does not retry when a dependency was skipped", () => {
    const task = makeTask({ error: "Skipped: dependency produced no output" });
    expect(isRetriable(task)).toBe(false);
  });

  it("does not retry when structured shell result shows env error (ENOENT)", () => {
    const task = makeTask({
      error: "generic error",
      toolCallResults: [
        { name: "shell_exec", exitCode: 2, stderrHead: "ENOENT: no such file" },
      ],
    });
    expect(isRetriable(task)).toBe(false);
  });
});
