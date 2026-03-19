import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoordinatorAgent } from "@/agents/coordinator.js";

vi.mock("../src/core/logger.js", () => ({
  logger: { agent: vi.fn(), plain: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn() },
  isDebugMode: () => false,
}));

vi.mock("../src/core/coordinator-events.js", () => ({
  coordinatorEvents: { emit: vi.fn() },
}));

// Helper to build a minimal GraphState-like object
function makeState(overrides: Record<string, unknown> = {}): any {
  return {
    team: [
      { id: "bot_0", name: "Engineer", role_id: "software_engineer", traits: {} },
      { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {} },
    ],
    task_queue: [],
    user_goal: "Build a REST API with auth",
    bot_stats: {},
    messages: [],
    ancestral_lessons: [],
    project_context: "",
    preferences_context: "",
    replanning_count: 0,
    replanning_max: 3,
    replanning_feedback: null,
    ...overrides,
  };
}

// Default decomposition response (valid JSON array)
const VALID_DECOMPOSITION = JSON.stringify([
  { description: "Set up project scaffolding", assigned_to: "bot_0", worker_tier: "light", complexity: "LOW", dependencies: [] },
  { description: "Implement auth middleware", assigned_to: "bot_0", worker_tier: "light", complexity: "HIGH", dependencies: [0] },
  { description: "Write integration tests", assigned_to: "bot_1", worker_tier: "light", complexity: "MEDIUM", dependencies: [0, 1] },
]);

// Feasibility responses
const FEASIBLE_RESPONSE = JSON.stringify({
  feasible: true,
  issues: [],
  suggestions: [],
  confidence: 0.92,
});

const INFEASIBLE_RESPONSE = JSON.stringify({
  feasible: false,
  issues: [
    'Task "Deploy to production" requires AWS credentials',
    'Task "Send email" requires SMTP configuration',
  ],
  suggestions: [
    "Replace deployment with local build verification",
    "Mock email sending for development",
  ],
  confidence: 0.85,
});

describe("Replanning retry loop", () => {
  let mockAdapter: { complete: ReturnType<typeof vi.fn>; executeTask: ReturnType<typeof vi.fn>; executeStream: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetAllMocks();
    mockAdapter = {
      complete: vi.fn(),
      executeTask: vi.fn(),
      executeStream: vi.fn(),
    };
  });

  it("feasible plan proceeds directly — tasks added, replanning cleared", async () => {
    // First call: decomposition, Second call: feasibility check
    mockAdapter.complete
      .mockResolvedValueOnce(VALID_DECOMPOSITION)
      .mockResolvedValueOnce(FEASIBLE_RESPONSE);

    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });
    const result = await agent.coordinateNode(makeState());

    // Tasks should be added
    expect(result.task_queue).toBeDefined();
    expect(result.task_queue!.length).toBeGreaterThanOrEqual(3);
    // user_goal cleared
    expect(result.user_goal).toBeNull();
    // replanning state reset
    expect(result.replanning_count).toBe(0);
    expect(result.replanning_feedback).toBeNull();
    // LLM called twice (decompose + feasibility)
    expect(mockAdapter.complete).toHaveBeenCalledTimes(2);
  });

  it("infeasible plan returns to coordinator with feedback — no tasks added", async () => {
    mockAdapter.complete
      .mockResolvedValueOnce(VALID_DECOMPOSITION)
      .mockResolvedValueOnce(INFEASIBLE_RESPONSE);

    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });
    const result = await agent.coordinateNode(makeState());

    // No tasks should be in result (infeasible plan rejected)
    expect(result.task_queue).toBeUndefined();
    // user_goal should NOT be cleared (so coordinator re-decomposes)
    expect(result.user_goal).toBeUndefined(); // not set = preserved from state
    // replanning_count incremented
    expect(result.replanning_count).toBe(1);
    // replanning_feedback set with issues
    expect(result.replanning_feedback).toContain("REPLANNING REQUIRED");
    expect(result.replanning_feedback).toContain("AWS credentials");
    expect(result.replanning_feedback).toContain("SMTP configuration");
    // UI message shows attempt number
    expect(result.messages![0]).toContain("Plan infeasible (attempt 1/3)");
  });

  it("replanning_count increments on each rejection", async () => {
    mockAdapter.complete
      .mockResolvedValueOnce(VALID_DECOMPOSITION)
      .mockResolvedValueOnce(INFEASIBLE_RESPONSE);

    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });

    // First attempt
    const result1 = await agent.coordinateNode(makeState({ replanning_count: 0 }));
    expect(result1.replanning_count).toBe(1);

    // Second attempt (simulating state after first rejection)
    mockAdapter.complete
      .mockResolvedValueOnce(VALID_DECOMPOSITION)
      .mockResolvedValueOnce(INFEASIBLE_RESPONSE);
    const result2 = await agent.coordinateNode(makeState({ replanning_count: 1 }));
    expect(result2.replanning_count).toBe(2);
  });

  it("after replanning_max attempts — gives up with error message", async () => {
    mockAdapter.complete
      .mockResolvedValueOnce(VALID_DECOMPOSITION)
      .mockResolvedValueOnce(INFEASIBLE_RESPONSE);

    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });
    const result = await agent.coordinateNode(makeState({
      replanning_count: 2, // already at 2, max is 3
      replanning_max: 3,
    }));

    // Should give up
    expect(result.user_goal).toBeNull(); // cleared — no more retries
    expect(result.replanning_feedback).toBeNull(); // cleared
    expect(result.replanning_count).toBe(3);
    // Error message to user
    expect(result.messages![0]).toContain("Could not create a feasible plan after 3 attempts");
    expect(result.messages![0]).toContain("AWS credentials");
    // No tasks added
    expect(result.task_queue).toBeUndefined();
  });

  it("coordinator prompt includes replanning_feedback on retry", async () => {
    const feedback = "[REPLANNING REQUIRED — ATTEMPT 1/3]\nIssues: Deploy requires AWS";

    mockAdapter.complete
      .mockResolvedValueOnce(VALID_DECOMPOSITION)
      .mockResolvedValueOnce(FEASIBLE_RESPONSE);

    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });
    await agent.coordinateNode(makeState({
      replanning_feedback: feedback,
      replanning_count: 1,
    }));

    // The first call (decomposition) should include the replanning feedback
    const decompositionCall = mockAdapter.complete.mock.calls[0];
    const userMessage = decompositionCall[0].find((m: { role: string }) => m.role === "user");
    expect(userMessage.content).toContain("REPLANNING REQUIRED");
    expect(userMessage.content).toContain("Deploy requires AWS");
    expect(userMessage.content).toContain("REVISED decomposition");
  });

  it("FeasibilityCheckSchema validates correctly", async () => {
    const { FeasibilityCheckSchema } = await import("@/llm/schemas.js");

    // Valid feasible
    const feasible = FeasibilityCheckSchema.safeParse({
      feasible: true, issues: [], suggestions: [], confidence: 0.9,
    });
    expect(feasible.success).toBe(true);

    // Valid infeasible
    const infeasible = FeasibilityCheckSchema.safeParse({
      feasible: false,
      issues: ["Missing dependency"],
      suggestions: ["Add dependency"],
      confidence: 0.8,
    });
    expect(infeasible.success).toBe(true);

    // Invalid confidence
    expect(FeasibilityCheckSchema.safeParse({
      feasible: true, issues: [], suggestions: [], confidence: 1.5,
    }).success).toBe(false);

    // Missing required field
    expect(FeasibilityCheckSchema.safeParse({
      feasible: true, issues: [],
    }).success).toBe(false);
  });

  it("issues list is non-empty when feasible=false from LLM", async () => {
    mockAdapter.complete
      .mockResolvedValueOnce(VALID_DECOMPOSITION)
      .mockResolvedValueOnce(INFEASIBLE_RESPONSE);

    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });
    const result = await agent.coordinateNode(makeState());

    // The replanning_feedback should contain the actual issues
    expect(result.replanning_feedback).toBeDefined();
    expect(result.replanning_feedback).toContain("AWS credentials");
    expect(result.replanning_feedback).toContain("SMTP configuration");
  });

  it("feasibility check failure is treated as feasible (graceful degradation)", async () => {
    mockAdapter.complete
      .mockResolvedValueOnce(VALID_DECOMPOSITION)
      .mockResolvedValueOnce("not valid json at all"); // malformed response

    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });
    const result = await agent.coordinateNode(makeState());

    // Should proceed as if feasible
    expect(result.task_queue).toBeDefined();
    expect(result.task_queue!.length).toBeGreaterThanOrEqual(3);
    expect(result.user_goal).toBeNull();
    expect(result.replanning_count).toBe(0);
  });
});
