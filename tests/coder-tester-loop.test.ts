import { describe, it, expect, vi } from "vitest";
import {
  WorkerBot,
  createWorkerTaskNode,
} from "@/agents/worker-bot.js";
import type { WorkerAdapter } from "@/adapters/worker-adapter.js";
import type { TaskResult } from "@/core/state.js";
import type { GraphState } from "@/core/graph-state.js";

function createMockAdapter(result: TaskResult): WorkerAdapter {
  return {
    adapterType: "provider",
    executeTask: vi.fn(() => Promise.resolve(result)),
    healthCheck: vi.fn(() => Promise.resolve(true)),
    getStatus: vi.fn(() => Promise.resolve({})),
    reset: vi.fn(() => Promise.resolve()),
  };
}

function makeTeam() {
  return [
    { id: "bot_coder", name: "Coder", role_id: "software_engineer", traits: {} },
    { id: "bot_qa", name: "QA", role_id: "qa_reviewer", traits: {} },
  ];
}

function makeWorkerBots(reviewOutput: string) {
  const coderAdapter = createMockAdapter({
    task_id: "TASK-001",
    success: true,
    output: "Implemented fix",
    quality_score: 0.8,
  });
  const reviewerAdapter = createMockAdapter({
    task_id: "TASK-001",
    success: true,
    output: reviewOutput,
    quality_score: 0.7,
  });

  const coderBot = new WorkerBot(
    { id: "bot_coder", name: "Coder", role_id: "software_engineer", traits: {} },
    coderAdapter
  );
  const reviewerBot = new WorkerBot(
    { id: "bot_qa", name: "QA", role_id: "qa_reviewer", traits: {} },
    reviewerAdapter
  );

  return { bot_coder: coderBot, bot_qa: reviewerBot };
}

function baseState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    task_queue: [],
    bot_stats: {},
    agent_messages: [],
    coder_tester_iterations: 0,
    coder_tester_max: 3,
    last_test_failure: null,
    ...overrides,
  } as unknown as GraphState;
}

describe("Coder ↔ Tester inner loop", () => {
  it("increments coder_tester_iterations on reviewer rejection", async () => {
    const bots = makeWorkerBots("REJECTED: Tests fail on edge case");
    const team = makeTeam();
    const node = createWorkerTaskNode(bots, team);

    const state = baseState({
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_qa",
        status: "reviewing",
        description: "Implement login",
        priority: "MEDIUM",
        result: { task_id: "TASK-001", success: true, output: "Login code", quality_score: 0.8 },
        retry_count: 0,
        max_retries: 5,
      },
      _send_bot_id: "bot_qa",
      coder_tester_iterations: 0,
      coder_tester_max: 3,
    });

    const out = await node(state);

    expect(out.coder_tester_iterations).toBe(1);
    expect(out.last_test_failure).toBe("Tests fail on edge case");
    const q = out.task_queue as Array<{ status: string }>;
    expect(q[0].status).toBe("needs_rework");
  });

  it("escalates to failed after max coder-tester iterations", async () => {
    const bots = makeWorkerBots("REJECTED: Still broken");
    const team = makeTeam();
    const node = createWorkerTaskNode(bots, team);

    // Already at 2 iterations, max is 3 — next rejection should escalate
    const state = baseState({
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_qa",
        status: "reviewing",
        description: "Implement login",
        priority: "MEDIUM",
        result: { task_id: "TASK-001", success: true, output: "Login code v3", quality_score: 0.8 },
        retry_count: 0,
        max_retries: 5,
      },
      _send_bot_id: "bot_qa",
      coder_tester_iterations: 2,
      coder_tester_max: 3,
    });

    const out = await node(state);

    expect(out.coder_tester_iterations).toBe(3);
    const q = out.task_queue as Array<{ status: string }>;
    expect(q[0].status).toBe("failed");
    const msgs = out.messages as string[];
    expect(msgs.some((m) => m.includes("Max coder-tester iterations reached"))).toBe(true);
  });

  it("resets counters when reviewer approves", async () => {
    const bots = makeWorkerBots("APPROVED");
    const team = makeTeam();
    const node = createWorkerTaskNode(bots, team);

    const state = baseState({
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_qa",
        status: "reviewing",
        description: "Implement login",
        priority: "MEDIUM",
        result: { task_id: "TASK-001", success: true, output: "Login code v2", quality_score: 0.9 },
        retry_count: 1,
        max_retries: 5,
      },
      _send_bot_id: "bot_qa",
      coder_tester_iterations: 1,
      coder_tester_max: 3,
      last_test_failure: "Previous test failure output",
    });

    const out = await node(state);

    expect(out.coder_tester_iterations).toBe(0);
    expect(out.last_test_failure).toBeNull();
    const q = out.task_queue as Array<{ status: string }>;
    expect(q[0].status).toBe("waiting_for_human");
  });

  it("passes last_test_failure to coder on rework", async () => {
    const coderAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: true,
      output: "Fixed implementation",
      quality_score: 0.85,
    });
    const reviewerAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: true,
      output: "APPROVED",
      quality_score: 0.9,
    });

    const coderBot = new WorkerBot(
      { id: "bot_coder", name: "Coder", role_id: "software_engineer", traits: {} },
      coderAdapter
    );
    const reviewerBot = new WorkerBot(
      { id: "bot_qa", name: "QA", role_id: "qa_reviewer", traits: {} },
      reviewerAdapter
    );

    const team = makeTeam();
    const node = createWorkerTaskNode({ bot_coder: coderBot, bot_qa: reviewerBot }, team);

    const state = baseState({
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_coder",
        status: "needs_rework",
        description: "Implement login",
        priority: "MEDIUM",
        result: null,
        retry_count: 1,
        max_retries: 5,
        reviewer_feedback: "Tests fail on null input",
      },
      _send_bot_id: "bot_coder",
      coder_tester_iterations: 1,
      coder_tester_max: 3,
      last_test_failure: "TypeError: Cannot read property 'id' of null",
    });

    await node(state);

    // Verify the coder received the failure context in the task description
    const callArgs = coderAdapter.executeTask as ReturnType<typeof vi.fn>;
    const taskReq = callArgs.mock.calls[0][0];
    expect(taskReq.description).toContain("Your previous implementation failed tests.");
    expect(taskReq.description).toContain("TypeError: Cannot read property 'id' of null");
    expect(taskReq.description).toContain("Do not rewrite from scratch unless absolutely necessary.");
  });

  it("shows correct attempt numbers in UI messages on rework", async () => {
    const coderAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: true,
      output: "Fixed v2",
      quality_score: 0.85,
    });
    const reviewerAdapter = createMockAdapter({
      task_id: "TASK-001",
      success: true,
      output: "APPROVED",
      quality_score: 0.9,
    });

    const coderBot = new WorkerBot(
      { id: "bot_coder", name: "Coder", role_id: "software_engineer", traits: {} },
      coderAdapter
    );
    const reviewerBot = new WorkerBot(
      { id: "bot_qa", name: "QA", role_id: "qa_reviewer", traits: {} },
      reviewerAdapter
    );

    const team = makeTeam();
    const node = createWorkerTaskNode({ bot_coder: coderBot, bot_qa: reviewerBot }, team);

    const state = baseState({
      _send_task: {
        task_id: "TASK-001",
        assigned_to: "bot_coder",
        status: "needs_rework",
        description: "Implement login",
        priority: "MEDIUM",
        result: null,
        retry_count: 1,
        max_retries: 5,
        reviewer_feedback: "Missing validation",
      },
      _send_bot_id: "bot_coder",
      coder_tester_iterations: 1,
      coder_tester_max: 3,
      last_test_failure: "Validation error",
    });

    const out = await node(state);
    const msgs = out.messages as string[];
    // Attempt should be iterations+1 = 2, max = 3
    expect(msgs.some((m) => m.includes("Coder → Tester (attempt 2/3)"))).toBe(true);
  });
});
