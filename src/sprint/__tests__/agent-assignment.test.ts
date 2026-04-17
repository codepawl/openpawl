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
 * Expose the protected `assignAgent` for direct testing.
 */
function assignAgent(runner: SprintRunner, task: SprintTask): string {
  return (runner as unknown as { assignAgent(t: SprintTask): string }).assignAgent(task);
}

describe("SprintRunner.assignAgent — planner self-misassignment guard", () => {
  it("downgrades planner → coder when task description has write intent", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Create src/foo.ts with a greet function",
      status: "pending",
      assignedAgent: "planner",
    };
    const agent = assignAgent(runner, task);
    expect(agent).toBe("coder");
    // The mutation is persisted on the task for observability
    expect(task.assignedAgent).toBe("coder");
  });

  it("leaves planner alone for read-only descriptions (no write keywords)", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Analyze the codebase structure and report findings",
      status: "pending",
      assignedAgent: "planner",
    };
    const agent = assignAgent(runner, task);
    // teamContext is absent and taskExpectsWrite is false, so the downgrade
    // guard does NOT fire — task.assignedAgent stays "planner". Then
    // assignAgent falls through to keyword rules; this description
    // contains "find" which matches the researcher rule. Fine for our
    // fix: the key assertion is that the planner tag survived the guard.
    expect(task.assignedAgent).toBe("planner");
    expect(agent).toBe("researcher"); // keyword match on "find"
  });

  it("leaves coder alone for write-intent task (no change)", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Create src/foo.ts with a greet function",
      status: "pending",
      assignedAgent: "coder",
    };
    const agent = assignAgent(runner, task);
    expect(task.assignedAgent).toBe("coder");
    // No teamContext, so assignAgent routes via keyword rules; description
    // has no keyword match, so falls through to "coder" default.
    expect(agent).toBe("coder");
  });

  it("leaves tester alone for a test-write task", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Write tests in src/foo.test.ts",
      status: "pending",
      assignedAgent: "tester",
    };
    assignAgent(runner, task);
    expect(task.assignedAgent).toBe("tester");
  });

  it("falls back to keyword rules when no assignedAgent is set (e.g. 'Run the tests' → tester)", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Run the test suite and verify all pass",
      status: "pending",
    };
    const agent = assignAgent(runner, task);
    expect(agent).toBe("tester");
  });

  it("honors a planner tag when the task is genuinely read-only (has no write keywords)", () => {
    const runner = new SprintRunner(mockRegistry());
    const task: SprintTask = {
      id: "t1",
      description: "Outline the architecture for a service", // "outline" matches planner keyword rule
      status: "pending",
      assignedAgent: "planner",
    };
    assignAgent(runner, task);
    // Downgrade guard does NOT fire (no write intent), so assignedAgent stays
    // "planner". No teamContext, so falls to keyword rules — "outline" maps
    // to planner, so agent returns "planner".
    expect(task.assignedAgent).toBe("planner");
  });
});
