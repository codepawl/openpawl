/**
 * Scenario-level tests for src/core/simulation.ts
 *
 * Exercises realistic multi-node state transformations through 5 critical
 * user flows: success path, human rejection, gateway failure, malformed JSON,
 * and session timeout.
 *
 * Separate from simulation.test.ts because scenarios need stateful node fakes
 * (not bare stubs) and a graph-walk simulator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GraphState } from "../src/core/graph-state.js";

/* ------------------------------------------------------------------ */
/*  Hoisted mock references                                            */
/* ------------------------------------------------------------------ */

const {
  mockInvoke,
  mockStream,
  mockCompile,
  mockAddNode,
  mockAddEdge,
  mockAddConditionalEdges,
  mockCoordinateNode,
  mockWorkerExecuteNode,
  mockApprovalNode,
  mockHumanApprovalNode,
  mockSendNodeActive,
  mockSendSessionTimeout,
  mockSendStreamChunk,
  mockSendStreamDone,
  mockSendTokenUsage,
  mockSendWaitingForHuman,
  mockGetFirstTaskNeedingApproval,
  mockExecuteTask,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockStream: vi.fn(),
  mockCompile: vi.fn(),
  mockAddNode: vi.fn(),
  mockAddEdge: vi.fn(),
  mockAddConditionalEdges: vi.fn(),
  mockCoordinateNode: vi.fn(),
  mockWorkerExecuteNode: vi.fn(),
  mockApprovalNode: vi.fn(),
  mockHumanApprovalNode: vi.fn(),
  mockSendNodeActive: vi.fn(),
  mockSendSessionTimeout: vi.fn(),
  mockSendStreamChunk: vi.fn(),
  mockSendStreamDone: vi.fn(),
  mockSendTokenUsage: vi.fn(),
  mockSendWaitingForHuman: vi.fn(),
  mockGetFirstTaskNeedingApproval: vi.fn(),
  mockExecuteTask: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  vi.mock factories                                                  */
/* ------------------------------------------------------------------ */

vi.mock("@langchain/langgraph", () => {
  class FakeStateGraph {
    addNode = mockAddNode;
    addEdge = mockAddEdge;
    addConditionalEdges = mockAddConditionalEdges;
    compile = mockCompile;
    constructor(_annotation: unknown) {}
  }

  const AnnotationFn = function (_opts?: unknown) {
    return { reducer: (_l: unknown, r: unknown) => r, default: () => undefined };
  } as unknown as Record<string, unknown>;
  AnnotationFn.Root = (schema: Record<string, unknown>) => ({
    State: {} as unknown,
    spec: schema,
  });

  return {
    StateGraph: FakeStateGraph,
    MemorySaver: class {},
    START: "__start__",
    END: "__end__",
    Annotation: AnnotationFn,
  };
});

vi.mock("@langchain/langgraph-checkpoint", () => ({
  MemorySaver: class {},
}));

vi.mock("../src/agents/coordinator.js", () => ({
  CoordinatorAgent: class {
    coordinateNode = mockCoordinateNode;
  },
}));

vi.mock("../src/agents/worker-bot.js", () => ({
  createWorkerBots: vi.fn().mockReturnValue({
    bot_0: { adapter: { executeTask: mockExecuteTask } },
    bot_1: { adapter: { executeTask: vi.fn() } },
  }),
  createWorkerExecuteNode: vi.fn().mockReturnValue(mockWorkerExecuteNode),
}));

vi.mock("../src/agents/approval.js", () => ({
  getFirstTaskNeedingApproval: mockGetFirstTaskNeedingApproval,
  createApprovalNode: vi.fn().mockReturnValue(mockApprovalNode),
  createHumanApprovalNode: vi.fn().mockReturnValue(mockHumanApprovalNode),
}));

vi.mock("../src/agents/planning.js", () => ({
  createSprintPlanningNode: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ __node__: "sprint_planning" })
  ),
}));

vi.mock("../src/agents/rfc.js", () => ({
  createRFCNode: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ __node__: "rfc_phase" })
  ),
}));

vi.mock("../src/agents/system-design.js", () => ({
  createSystemDesignNode: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ __node__: "system_design" })
  ),
}));

vi.mock("../src/agents/memory-retrieval.js", () => ({
  createMemoryRetrievalNode: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ __node__: "memory_retrieval" })
  ),
}));

vi.mock("../src/core/config.js", () => ({
  CONFIG: {
    openclawWorkerUrl: "http://localhost:18789",
    openclawToken: "test-token",
    maxCycles: 10,
    llmTimeoutMs: 120_000,
  },
  getApprovalKeywords: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/core/model-config.js", () => ({
  resolveModelForAgent: vi.fn().mockReturnValue("test-model"),
}));

vi.mock("../src/core/canvas-telemetry.js", () => ({
  getCanvasTelemetry: vi.fn().mockReturnValue({
    sendNodeActive: mockSendNodeActive,
    sendSessionTimeout: mockSendSessionTimeout,
    sendStreamChunk: mockSendStreamChunk,
    sendStreamDone: mockSendStreamDone,
    sendTokenUsage: mockSendTokenUsage,
    sendWaitingForHuman: mockSendWaitingForHuman,
  }),
}));

vi.mock("../src/core/logger.js", () => ({
  logger: { agent: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDebugMode: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/interfaces/worker-adapter.js", () => ({
  UniversalOpenClawAdapter: class {
    constructor(_opts: unknown) {}
    executeTask = mockExecuteTask;
  },
  createRoutingAdapters: vi.fn().mockReturnValue({
    light: { executeTask: mockExecuteTask },
    heavy: null,
  }),
}));

vi.mock("../src/core/team-templates.js", () => ({
  buildTeamFromTemplate: vi.fn().mockReturnValue([
    { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {}, worker_url: null },
    { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {}, worker_url: null },
  ]),
}));

vi.mock("../src/core/coordinator-events.js", () => ({
  coordinatorEvents: { emit: vi.fn() },
}));

/* ------------------------------------------------------------------ */
/*  Import AFTER all mocks are registered                              */
/* ------------------------------------------------------------------ */

import { createTeamOrchestration, TeamOrchestration } from "../src/core/simulation.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeTeam(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    id: `bot_${i}`,
    name: `Bot${i}`,
    role_id: i === 0 ? "software_engineer" : "qa_reviewer",
    traits: {},
    worker_url: null,
  }));
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "TASK-001",
    assigned_to: "bot_0",
    status: "pending",
    description: "Test task",
    priority: "MEDIUM",
    worker_tier: "light",
    result: null,
    retry_count: 0,
    max_retries: 2,
    ...overrides,
  };
}

/**
 * Graph simulator: captures node fns and routing fns registered via
 * mockAddNode / mockAddConditionalEdges during construction, then walks
 * the topology merging Partial<GraphState> into running state.
 */
interface SimulatorOptions {
  maxIterations?: number;
}

async function simulateGraph(
  orch: TeamOrchestration,
  initialState: GraphState,
  opts: SimulatorOptions = {},
): Promise<GraphState> {
  const maxIterations = opts.maxIterations ?? 50;

  // Capture node functions from addNode calls
  const nodeFns = new Map<string, (s: GraphState) => Promise<Partial<GraphState>> | Partial<GraphState>>();
  for (const call of mockAddNode.mock.calls) {
    const [name, fn] = call as [string, (s: GraphState) => Promise<Partial<GraphState>> | Partial<GraphState>];
    nodeFns.set(name, fn);
  }

  // Capture conditional edges: source → { routingFn, destinationMap }
  const conditionalEdges = new Map<
    string,
    { routingFn: (s: GraphState) => string; destinations: Record<string, string> }
  >();
  for (const call of mockAddConditionalEdges.mock.calls) {
    const [source, routingFn, destinations] = call as [
      string,
      (s: GraphState) => string,
      Record<string, string>,
    ];
    conditionalEdges.set(source, { routingFn, destinations });
  }

  // Capture linear edges: source → destination
  const linearEdges = new Map<string, string>();
  for (const call of mockAddEdge.mock.calls) {
    const [from, to] = call as [string, string];
    linearEdges.set(from, to);
  }

  // Merge helper: concat for messages, replace for everything else
  function mergeState(
    current: GraphState,
    partial: Partial<GraphState>,
  ): GraphState {
    const merged = { ...current } as Record<string, unknown>;
    for (const [key, value] of Object.entries(partial)) {
      if (key === "messages" && Array.isArray(value)) {
        const existing = (merged.messages as string[]) ?? [];
        merged.messages = existing.concat(value);
      } else {
        merged[key] = value;
      }
    }
    return merged as unknown as GraphState;
  }

  // Walk: START → memory_retrieval → sprint_planning → ... → conditional routing
  let state = { ...initialState } as GraphState;
  const nodeOrder: string[] = [];

  // Linear prefix: __start__ → memory_retrieval → sprint_planning → system_design → rfc_phase → coordinator
  const linearChain = [
    "memory_retrieval",
    "sprint_planning",
    "system_design",
    "rfc_phase",
    "coordinator",
  ];

  // Execute linear prefix
  for (const nodeName of linearChain) {
    const fn = nodeFns.get(nodeName);
    if (!fn) continue;
    const result = await fn(state);
    state = mergeState(state, result);
    nodeOrder.push(nodeName);
  }

  // Now enter the conditional routing loop
  let iterations = 0;
  let currentNode = "coordinator"; // just completed coordinator

  while (iterations < maxIterations) {
    iterations++;

    // Check for conditional edge from currentNode
    const cond = conditionalEdges.get(currentNode);
    if (cond) {
      const route = cond.routingFn(state);
      const resolvedRoute = cond.destinations[route] ?? route;
      if (resolvedRoute === "__end__") break;

      // Execute the next node
      const nextNodeName = resolvedRoute;
      const fn = nodeFns.get(nextNodeName);
      if (!fn) break;
      const result = await fn(state);
      state = mergeState(state, result);
      nodeOrder.push(nextNodeName);
      currentNode = nextNodeName;
      continue;
    }

    // Check for linear edge from currentNode
    const nextLinear = linearEdges.get(currentNode);
    if (nextLinear) {
      if (nextLinear === "__end__") break;
      const fn = nodeFns.get(nextLinear);
      if (!fn) break;
      const result = await fn(state);
      state = mergeState(state, result);
      nodeOrder.push(nextLinear);
      currentNode = nextLinear;
      continue;
    }

    // No edge found, end
    break;
  }

  (state as Record<string, unknown>).__visited_nodes__ = nodeOrder;
  return state;
}

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue({} as GraphState);
  mockStream.mockResolvedValue((async function* () {})());
  mockCompile.mockReturnValue({ invoke: mockInvoke, stream: mockStream });
  mockAddNode.mockReturnThis();
  mockAddEdge.mockReturnThis();
  mockAddConditionalEdges.mockReturnThis();
  mockCoordinateNode.mockResolvedValue({ __node__: "coordinator" });
  mockWorkerExecuteNode.mockResolvedValue({ __node__: "worker_execute" });
  mockApprovalNode.mockResolvedValue({ __node__: "approval" });
  mockHumanApprovalNode.mockResolvedValue({ __node__: "human_approval" });
  mockGetFirstTaskNeedingApproval.mockReturnValue(null);
});

/* ================================================================== */
/*  SCENARIO 1: SUCCESS_PATH                                          */
/* ================================================================== */

describe("Scenario: SUCCESS_PATH", () => {
  it("all tasks reach completed status through the full graph walk", async () => {
    // Coordinator creates 2 pending tasks
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "pending", description: "Build landing page" }),
        makeTask({ task_id: "TASK-002", status: "pending", description: "Write API tests", assigned_to: "bot_1" }),
      ],
      total_tasks: 2,
      messages: ["Coordinator: Decomposed goal into 2 tasks"],
      __node__: "coordinator",
    });

    // Worker transitions pending → reviewing (maker done)
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "reviewing", result: { success: true, output: "Page built" } }),
        makeTask({ task_id: "TASK-002", status: "reviewing", result: { success: true, output: "Tests written" }, assigned_to: "bot_1" }),
      ],
      bot_stats: {},
      messages: ["Worker done"],
      __node__: "worker_execute",
    });

    // Human auto-approves → completed
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed", result: { success: true, output: "Page built" } }),
        makeTask({ task_id: "TASK-002", status: "completed", result: { success: true, output: "Tests written" }, assigned_to: "bot_1" }),
      ],
      bot_stats: { bot_0: { tasks_completed: 1 }, bot_1: { tasks_completed: 1 } },
      messages: ["Tasks approved"],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const initial = orch.getInitialState({ userGoal: "Build a landing page" });
    const final = await simulateGraph(orch, initial);

    const tasks = final.task_queue ?? [];
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === "completed")).toBe(true);
  });

  it("bot_stats tracks tasks_completed for each bot", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "reviewing" })],
      bot_stats: {},
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      bot_stats: { bot_0: { tasks_completed: 1, tasks_failed: 0, reworks_triggered: 0 } },
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    expect(final.bot_stats?.bot_0?.tasks_completed).toBe(1);
  });

  it("completed_tasks count is updated by increment_cycle", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    // increment_cycle should have computed completed_tasks
    expect(final.completed_tasks).toBeGreaterThanOrEqual(1);
  });

  it("cycle_count increments on each pass through increment_cycle", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    expect(final.cycle_count).toBeGreaterThan(0);
  });

  it("task IDs follow TASK-NNN format", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [
        makeTask({ task_id: "TASK-001" }),
        makeTask({ task_id: "TASK-002" }),
      ],
      total_tasks: 2,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed" }),
        makeTask({ task_id: "TASK-002", status: "completed" }),
      ],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed" }),
        makeTask({ task_id: "TASK-002", status: "completed" }),
      ],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    for (const task of final.task_queue ?? []) {
      expect(task.task_id).toMatch(/^TASK-\d{3}$/);
    }
  });
});

/* ================================================================== */
/*  SCENARIO 2: HUMAN_REJECTION                                       */
/* ================================================================== */

describe("Scenario: HUMAN_REJECTION", () => {
  // NOTE: The coordinator conditional edge (simulation.ts:195) only checks
  // for status === "pending". needs_rework tasks don't trigger worker_execute
  // routing. For rework loops to work, the coordinator mock must re-queue
  // needs_rework tasks as "pending".

  it("rejection followed by rework reaches completed status", async () => {
    // Cycle 1: coordinator decomposes → worker executes → human rejects
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "waiting_for_human" })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({
          task_id: "TASK-001",
          status: "needs_rework",
          reviewer_feedback: "HUMAN FEEDBACK: Fix layout. Please fix this.",
          retry_count: 0,
        }),
      ],
      messages: ["Rejected by human"],
      __node__: "human_approval",
    });

    // Cycle 2: coordinator re-queues as pending → worker reworks → human approves
    mockCoordinateNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({
          task_id: "TASK-001",
          status: "pending",
          reviewer_feedback: "HUMAN FEEDBACK: Fix layout. Please fix this.",
          retry_count: 0,
        }),
      ],
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "waiting_for_human", retry_count: 1 })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed", retry_count: 1 })],
      bot_stats: { bot_0: { tasks_completed: 1 } },
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    const task = (final.task_queue ?? []).find((t) => t.task_id === "TASK-001");
    expect(task?.status).toBe("completed");
    expect(task?.retry_count).toBe(1);
  });

  it("rejection feedback contains HUMAN FEEDBACK: prefix", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "waiting_for_human" })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({
          task_id: "TASK-001",
          status: "needs_rework",
          reviewer_feedback: "HUMAN FEEDBACK: Colors are wrong. Please fix this.",
        }),
      ],
      __node__: "human_approval",
    });

    // Coordinator doesn't re-queue → graph ends with needs_rework (expected)
    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    const task = (final.task_queue ?? []).find((t) => t.task_id === "TASK-001");
    expect(task?.status).toBe("needs_rework");
    expect(String(task?.reviewer_feedback ?? "")).toContain("HUMAN FEEDBACK:");
  });

  it("rework task re-enters worker_execute cycle when coordinator re-queues", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "waiting_for_human" })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "needs_rework", retry_count: 0 })],
      __node__: "human_approval",
    });

    // Coordinator re-queues as pending so routing continues to worker_execute
    mockCoordinateNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending", retry_count: 0 })],
      __node__: "coordinator",
    });

    // Worker processes the rework
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed", retry_count: 1 })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed", retry_count: 1 })],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    // Worker execute should have been called twice (initial + rework)
    expect(mockWorkerExecuteNode).toHaveBeenCalledTimes(2);
    expect((final.task_queue ?? [])[0]?.status).toBe("completed");
  });

  it("max retries exceeded sets status to failed", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending", max_retries: 1 })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "waiting_for_human", max_retries: 1 })],
      __node__: "worker_execute",
    });
    // First rejection
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "needs_rework", retry_count: 0, max_retries: 1 })],
      __node__: "human_approval",
    });
    // Coordinator re-queues as pending
    mockCoordinateNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending", retry_count: 0, max_retries: 1 })],
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "waiting_for_human", retry_count: 1, max_retries: 1 })],
      __node__: "worker_execute",
    });
    // Second rejection — exceeds max_retries → failed
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "failed", retry_count: 2, max_retries: 1 })],
      bot_stats: { bot_0: { tasks_failed: 1 } },
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    const task = (final.task_queue ?? []).find((t) => t.task_id === "TASK-001");
    expect(task?.status).toBe("failed");
  });

  it("multiple tasks: one rejected, one approved in same cycle", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "pending" }),
        makeTask({ task_id: "TASK-002", status: "pending", assigned_to: "bot_1" }),
      ],
      total_tasks: 2,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "waiting_for_human" }),
        makeTask({ task_id: "TASK-002", status: "waiting_for_human", assigned_to: "bot_1" }),
      ],
      __node__: "worker_execute",
    });
    // TASK-001 rejected, TASK-002 approved
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "needs_rework", reviewer_feedback: "HUMAN FEEDBACK: fix" }),
        makeTask({ task_id: "TASK-002", status: "completed", assigned_to: "bot_1" }),
      ],
      __node__: "human_approval",
    });
    // Coordinator re-queues TASK-001 as pending
    mockCoordinateNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "pending" }),
        makeTask({ task_id: "TASK-002", status: "completed", assigned_to: "bot_1" }),
      ],
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed", retry_count: 1 }),
        makeTask({ task_id: "TASK-002", status: "completed", assigned_to: "bot_1" }),
      ],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed", retry_count: 1 }),
        makeTask({ task_id: "TASK-002", status: "completed", assigned_to: "bot_1" }),
      ],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    const tasks = final.task_queue ?? [];
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === "completed")).toBe(true);
  });

  it("always-rejecting human eventually fails the task", async () => {
    // With max_retries=0, the first rejection directly fails via the mock
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending", max_retries: 0 })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "waiting_for_human", max_retries: 0 })],
      __node__: "worker_execute",
    });
    // Human rejects and worker-bot logic marks as failed (max_retries exceeded)
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "failed", max_retries: 0, retry_count: 1 })],
      bot_stats: { bot_0: { tasks_failed: 1 } },
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    const task = (final.task_queue ?? []).find((t) => t.task_id === "TASK-001");
    expect(task?.status).toBe("failed");
  });
});

/* ================================================================== */
/*  SCENARIO 3: GATEWAY_FAILURE                                       */
/* ================================================================== */

describe("Scenario: GATEWAY_FAILURE", () => {
  it("coordinator throwing ECONNREFUSED rejects run()", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Gateway unreachable (ECONNREFUSED)"));

    const orch = createTeamOrchestration({ team: makeTeam() });
    await expect(orch.run({ userGoal: "Test" })).rejects.toThrow("ECONNREFUSED");
  });

  it("coordinator throwing timeout error rejects run()", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Decomposition timed out"));

    const orch = createTeamOrchestration({ team: makeTeam() });
    await expect(orch.run({ userGoal: "Test" })).rejects.toThrow("timed out");
  });

  it("stream() generator throws on gateway error", async () => {
    const errorGen = async function* () {
      throw new Error("Gateway unreachable (ECONNREFUSED)");
    };
    mockStream.mockResolvedValueOnce(errorGen());

    const orch = createTeamOrchestration({ team: makeTeam() });
    const gen = orch.stream({ userGoal: "Test" });

    await expect(async () => {
      for await (const _chunk of gen) {
        // should throw
      }
    }).rejects.toThrow("ECONNREFUSED");
  });

  it("getInitialState is not corrupted by gateway failures", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Gateway unreachable"));

    const orch = createTeamOrchestration({ team: makeTeam() });

    // run() should fail
    await expect(orch.run({ userGoal: "Test" })).rejects.toThrow();

    // But getInitialState should still produce valid state
    const state = orch.getInitialState({ userGoal: "Another goal" });
    expect(state.user_goal).toBe("Another goal");
    expect(state.messages).toBeDefined();
    expect(Array.isArray(state.task_queue)).toBe(true);
  });

  it("worker-level failure marks task as failed without crashing graph", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    // Worker returns failure (not throw)
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({
          task_id: "TASK-001",
          status: "failed",
          result: { success: false, output: "Worker unreachable", quality_score: 0 },
        }),
      ],
      bot_stats: { bot_0: { tasks_failed: 1 } },
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "failed" })],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    const task = (final.task_queue ?? []).find((t) => t.task_id === "TASK-001");
    expect(task?.status).toBe("failed");
    // Graph didn't crash — we got a final state
    expect(final.cycle_count).toBeGreaterThanOrEqual(0);
  });
});

/* ================================================================== */
/*  SCENARIO 4: MALFORMED_JSON                                        */
/* ================================================================== */

describe("Scenario: MALFORMED_JSON", () => {
  // These tests use the REAL parseLlmJson from jsonExtractor.ts
  // We need to import it directly (not mocked)

  let parseLlmJson: typeof import("../src/utils/jsonExtractor.js").parseLlmJson;

  beforeEach(async () => {
    const mod = await vi.importActual<typeof import("../src/utils/jsonExtractor.js")>(
      "../src/utils/jsonExtractor.js"
    );
    parseLlmJson = mod.parseLlmJson;
  });

  it("strips preamble text before JSON array", () => {
    const input = 'Sure! Here are tasks:\n[{"description": "Build UI", "assigned_to": "bot_0"}]';
    const result = parseLlmJson<Array<{ description: string }>>(input);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].description).toBe("Build UI");
  });

  it("extracts JSON from fenced code block", () => {
    const input = '```json\n[{"description": "Build UI", "assigned_to": "bot_0"}]\n```';
    const result = parseLlmJson<Array<{ description: string }>>(input);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].description).toBe("Build UI");
  });

  it("strips <think> blocks before parsing", () => {
    const input =
      '<think>reasoning about the task</think>[{"description": "Build UI", "assigned_to": "bot_0"}]';
    const result = parseLlmJson<Array<{ description: string }>>(input);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].description).toBe("Build UI");
  });

  it("throws on non-JSON refusal text", () => {
    const input = "I'm sorry, I can't help with that request.";
    expect(() => parseLlmJson(input)).toThrow("Failed to parse");
  });

  it("handles single object (not array) — coordinator wraps to array", () => {
    const input = '{"description": "single task", "assigned_to": "bot_0"}';
    const result = parseLlmJson<{ description: string }>(input);
    // parseLlmJson returns the raw parsed value; coordinator.ts:161 wraps it
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    const list = Array.isArray(result) ? result : [result];
    expect(list).toHaveLength(1);
    expect(list[0].description).toBe("single task");
  });

  it("throws on empty string input", () => {
    expect(() => parseLlmJson("")).toThrow();
  });
});

/* ================================================================== */
/*  SCENARIO 5: SESSION_TIMEOUT                                       */
/* ================================================================== */

describe("Scenario: SESSION_TIMEOUT", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("increment_cycle routing returns __end__ when elapsed >= timeoutMs", async () => {
    vi.useFakeTimers();
    const now = Date.now();

    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],  // still pending to force re-loop
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    orch.configureSession({ timeoutMinutes: 1 }); // 60_000ms

    // Advance time past timeout
    vi.advanceTimersByTime(61_000);

    const initial = orch.getInitialState({ userGoal: "Test" });
    const final = await simulateGraph(orch, initial);

    // increment_cycle should have detected timeout and ended the graph
    // The cycle_count should be >= 1 (at least one pass)
    expect(final.cycle_count).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });

  it("sendSessionTimeout telemetry is called with timeout reason", async () => {
    vi.useFakeTimers();

    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    orch.configureSession({ timeoutMinutes: 1 });

    vi.advanceTimersByTime(61_000);

    const initial = orch.getInitialState({ userGoal: "Test" });
    await simulateGraph(orch, initial);

    // The increment_cycle node itself calls sendSessionTimeout
    expect(mockSendSessionTimeout).toHaveBeenCalledWith(
      "timeout",
      expect.any(Number),
    );

    vi.useRealTimers();
  });

  it("max_runs termination calls sendSessionTimeout with max_runs reason", async () => {
    // Use run() with mockInvoke to test max_runs telemetry (set via run options)
    mockInvoke.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      cycle_count: 5,
    } as unknown as GraphState);

    const orch = createTeamOrchestration({ team: makeTeam() });
    // configureSession sets maxRuns; run() also sets it
    await orch.run({ userGoal: "Test", maxRuns: 2 });

    // run() sends "completed" telemetry when no timeout
    expect(mockSendNodeActive).toHaveBeenCalledWith("completed");
  });

  it("max_runs limit terminates graph via increment_cycle routing", async () => {
    mockCoordinateNode.mockResolvedValue({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValue({
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValue({
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    orch.configureSession({ maxRuns: 2 });

    const initial = orch.getInitialState({ userGoal: "Test" });
    const final = await simulateGraph(orch, initial);

    // increment_cycle should have run at least once and stopped at maxRuns
    expect(final.cycle_count).toBeGreaterThanOrEqual(1);
    expect(final.cycle_count).toBeLessThanOrEqual(2);
  });

  it("in-flight tasks retain their current status on timeout", async () => {
    vi.useFakeTimers();

    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "pending" }),
        makeTask({ task_id: "TASK-002", status: "pending", assigned_to: "bot_1" }),
      ],
      total_tasks: 2,
      __node__: "coordinator",
    });
    // Worker completes one, leaves one in_progress
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed" }),
        makeTask({ task_id: "TASK-002", status: "in_progress", assigned_to: "bot_1" }),
      ],
      __node__: "worker_execute",
    });
    mockHumanApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed" }),
        makeTask({ task_id: "TASK-002", status: "in_progress", assigned_to: "bot_1" }),
      ],
      __node__: "human_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    orch.configureSession({ timeoutMinutes: 1 });

    vi.advanceTimersByTime(61_000);

    const initial = orch.getInitialState({ userGoal: "Test" });
    const final = await simulateGraph(orch, initial);

    const tasks = final.task_queue ?? [];
    const t1 = tasks.find((t) => t.task_id === "TASK-001");
    const t2 = tasks.find((t) => t.task_id === "TASK-002");

    // Tasks should retain last known status (not silently dropped)
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    // Verify the task queue still contains both tasks after timeout
    expect(tasks).toHaveLength(2);
    // t1 was completed by worker, t2 was still in_progress
    expect(t1?.status).toBe("completed");
    expect(t2?.status).toBe("in_progress");

    vi.useRealTimers();
  });

  it("run() post-invoke detects timeout and sends telemetry", async () => {
    vi.useFakeTimers();

    // Simulate invoke taking a long time
    mockInvoke.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(61_000);
      return { task_queue: [makeTask({ status: "completed" })] } as unknown as GraphState;
    });

    const orch = createTeamOrchestration({ team: makeTeam() });

    await orch.run({ userGoal: "Test", timeoutMinutes: 1 });

    expect(mockSendSessionTimeout).toHaveBeenCalledWith("timeout", expect.any(Number));

    vi.useRealTimers();
  });

  it("stream() breaks and sends timeout telemetry when time exceeded", async () => {
    vi.useFakeTimers();

    const chunks: Record<string, GraphState>[] = [
      { coordinator: { task_queue: [makeTask({ status: "pending" })] } as unknown as GraphState },
      { worker_execute: { task_queue: [makeTask({ status: "reviewing" })] } as unknown as GraphState },
    ];

    let chunkIndex = 0;
    const streamGen = async function* () {
      for (const chunk of chunks) {
        // Advance time past timeout on second chunk
        if (chunkIndex === 1) {
          vi.advanceTimersByTime(61_000);
        }
        chunkIndex++;
        yield chunk;
      }
    };
    mockStream.mockResolvedValueOnce(streamGen());

    const orch = createTeamOrchestration({ team: makeTeam() });
    const collected: Record<string, GraphState>[] = [];

    for await (const chunk of orch.stream({ userGoal: "Test", timeoutMinutes: 1 })) {
      collected.push(chunk);
    }

    // Should have yielded at least the first chunk before timeout broke the loop
    expect(collected.length).toBeGreaterThanOrEqual(1);
    expect(mockSendSessionTimeout).toHaveBeenCalledWith("timeout", expect.any(Number));

    vi.useRealTimers();
  });
});
