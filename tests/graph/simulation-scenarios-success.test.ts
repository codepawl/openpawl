/**
 * Scenario-level tests: SUCCESS_PATH and HUMAN_REJECTION
 *
 * Split from simulation-scenarios.test.ts for parallel test execution.
 * All vi.hoisted() and vi.mock() calls are inline because they cannot
 * be exported from shared files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GraphState } from "@/core/graph-state.js";

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
  mockTaskDispatcher,
  mockApprovalNode,
  mockPartialApprovalNode,
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
  mockTaskDispatcher: vi.fn(),
  mockApprovalNode: vi.fn(),
  mockPartialApprovalNode: vi.fn(),
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
    Send: class FakeSend {
      node: string;
      args: Record<string, unknown>;
      constructor(node: string, args: Record<string, unknown>) {
        this.node = node;
        this.args = args;
      }
    },
  };
});

vi.mock("@langchain/langgraph-checkpoint", () => ({
  MemorySaver: class {},
}));

vi.mock("@/agents/coordinator.js", () => ({
  CoordinatorAgent: class {
    coordinateNode = mockCoordinateNode;
  },
}));

vi.mock("@/agents/worker-bot.js", () => ({
  createWorkerBots: vi.fn().mockReturnValue({
    bot_0: { adapter: { executeTask: mockExecuteTask } },
    bot_1: { adapter: { executeTask: vi.fn() } },
  }),
  createTaskDispatcher: vi.fn().mockReturnValue(mockTaskDispatcher),
  createWorkerTaskNode: vi.fn().mockReturnValue(mockWorkerExecuteNode),
  createWorkerCollectNode: vi.fn().mockReturnValue(vi.fn().mockReturnValue({
    last_action: "Dispatched via parallel Send",
    last_quality_score: 0,
    deep_work_mode: true,
    __node__: "worker_collect",
  })),
}));

vi.mock("@/agents/approval.js", () => ({
  getFirstTaskNeedingApproval: mockGetFirstTaskNeedingApproval,
  createApprovalNode: vi.fn().mockReturnValue(mockApprovalNode),
}));

vi.mock("@/agents/partial-approval.js", () => ({
  createPartialApprovalNode: vi.fn().mockReturnValue(mockPartialApprovalNode),
}));

vi.mock("@/graph/nodes/preview.js", () => ({
  createPreviewNode: vi.fn().mockReturnValue(
    vi.fn().mockImplementation(() => ({
      preview: { tasks: [], estimate: { estimatedUSD: 0, parallelWaves: 0, rfcRequired: false, estimatedMinutes: 0 }, status: "approved" },
      __node__: "preview_gate",
    }))
  ),
}));

vi.mock("@/graph/nodes/confidence-router.js", () => ({
  createConfidenceRouterNode: vi.fn().mockReturnValue(
    vi.fn().mockImplementation((state: Record<string, unknown>) => {
      // Transition reviewing/waiting_for_human tasks to auto_approved_pending
      const taskQueue = (state.task_queue as Record<string, unknown>[]) ?? [];
      const updated = taskQueue.map((t) => {
        const st = t.status as string;
        if (st === "reviewing" || st === "waiting_for_human") {
          return { ...t, status: "auto_approved_pending", result: { ...(t.result as Record<string, unknown> ?? {}), routing_decision: "auto_approved" } };
        }
        return t;
      });
      return { task_queue: updated, __node__: "confidence_router" };
    })
  ),
}));

vi.mock("@/agents/planning.js", () => ({
  createSprintPlanningNode: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ __node__: "sprint_planning" })
  ),
}));

vi.mock("@/agents/rfc.js", () => ({
  createRFCNode: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ __node__: "rfc_phase" })
  ),
}));

vi.mock("@/agents/system-design.js", () => ({
  createSystemDesignNode: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ __node__: "system_design" })
  ),
}));

vi.mock("@/agents/memory-retrieval.js", () => ({
  createMemoryRetrievalNode: vi.fn().mockReturnValue(
    vi.fn().mockResolvedValue({ __node__: "memory_retrieval" })
  ),
}));

vi.mock("@/core/config.js", () => ({
  CONFIG: {
    maxCycles: 10,
    llmTimeoutMs: 120_000,
  },
  getApprovalKeywords: vi.fn().mockReturnValue([]),
}));

vi.mock("@/core/model-config.js", () => ({
  resolveModelForAgent: vi.fn().mockReturnValue("test-model"),
}));

vi.mock("@/core/canvas-telemetry.js", () => ({
  getCanvasTelemetry: vi.fn().mockReturnValue({
    sendNodeActive: mockSendNodeActive,
    sendSessionTimeout: mockSendSessionTimeout,
    sendStreamChunk: mockSendStreamChunk,
    sendStreamDone: mockSendStreamDone,
    sendTokenUsage: mockSendTokenUsage,
    sendWaitingForHuman: mockSendWaitingForHuman,
  }),
}));

vi.mock("@/core/logger.js", () => ({
  logger: { agent: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDebugMode: vi.fn().mockReturnValue(false),
}));

vi.mock("@/interfaces/worker-adapter.js", () => ({
  UniversalWorkerAdapter: class {
    constructor(_opts: unknown) {}
    executeTask = mockExecuteTask;
  },
  createRoutingAdapters: vi.fn().mockReturnValue({
    light: { executeTask: mockExecuteTask },
    heavy: null,
  }),
}));

vi.mock("@/core/team-templates.js", () => ({
  buildTeamFromTemplate: vi.fn().mockReturnValue([
    { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {}, worker_url: null },
    { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {}, worker_url: null },
  ]),
}));

vi.mock("@/core/coordinator-events.js", () => ({
  coordinatorEvents: { emit: vi.fn() },
}));

/* ------------------------------------------------------------------ */
/*  Import AFTER all mocks are registered                              */
/* ------------------------------------------------------------------ */

import { createTeamOrchestration, TeamOrchestration } from "@/core/simulation.js";

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

  // Linear prefix: __start__ → memory_retrieval → sprint_planning → system_design → rfc_phase → coordinator → preview
  const linearChain = [
    "memory_retrieval",
    "sprint_planning",
    "system_design",
    "rfc_phase",
    "coordinator",
    "preview_gate",
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
  let currentNode = "preview_gate"; // just completed preview (after coordinator)

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
  mockPartialApprovalNode.mockResolvedValue({ __node__: "partial_approval" });
  mockGetFirstTaskNeedingApproval.mockReturnValue(null);
  mockTaskDispatcher.mockReturnValue("worker_task");
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed", result: { success: true, output: "Page built" } }),
        makeTask({ task_id: "TASK-002", status: "completed", result: { success: true, output: "Tests written" }, assigned_to: "bot_1" }),
      ],
      bot_stats: { bot_0: { tasks_completed: 1 }, bot_1: { tasks_completed: 1 } },
      messages: ["Tasks approved"],
      __node__: "partial_approval",
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      bot_stats: { bot_0: { tasks_completed: 1, tasks_failed: 0, reworks_triggered: 0 } },
      __node__: "partial_approval",
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "partial_approval",
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "partial_approval",
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed" }),
        makeTask({ task_id: "TASK-002", status: "completed" }),
      ],
      __node__: "partial_approval",
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({
          task_id: "TASK-001",
          status: "needs_rework",
          reviewer_feedback: "HUMAN FEEDBACK: Fix layout. Please fix this.",
          retry_count: 0,
        }),
      ],
      messages: ["Rejected by human"],
      __node__: "partial_approval",
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed", retry_count: 1 })],
      bot_stats: { bot_0: { tasks_completed: 1 } },
      __node__: "partial_approval",
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({
          task_id: "TASK-001",
          status: "needs_rework",
          reviewer_feedback: "HUMAN FEEDBACK: Colors are wrong. Please fix this.",
        }),
      ],
      __node__: "partial_approval",
    });

    // Coordinator doesn't re-queue → graph ends with needs_rework (expected)
    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    const task = (final.task_queue ?? []).find((t) => t.task_id === "TASK-001");
    expect(task?.status).toBe("needs_rework");
    expect(String(task?.reviewer_feedback ?? "")).toContain("HUMAN FEEDBACK:");
  });

  it("rework task re-enters worker_execute cycle when partial_approval routes to worker", async () => {
    mockCoordinateNode.mockResolvedValueOnce({
      user_goal: null,
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],
      total_tasks: 1,
      __node__: "coordinator",
    });
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "reviewing" })],
      __node__: "worker_execute",
    });
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "needs_rework", retry_count: 0 })],
      __node__: "partial_approval",
    });

    // Rework goes directly to worker_task (via partial_approval → taskDispatcher)
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "reviewing", retry_count: 1 })],
      __node__: "worker_execute",
    });
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed", retry_count: 1 })],
      __node__: "partial_approval",
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
      task_queue: [makeTask({ task_id: "TASK-001", status: "reviewing", max_retries: 1 })],
      __node__: "worker_execute",
    });
    // First rejection
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "needs_rework", retry_count: 0, max_retries: 1 })],
      __node__: "partial_approval",
    });
    // Rework goes directly to worker_task (not coordinator)
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "reviewing", retry_count: 1, max_retries: 1 })],
      __node__: "worker_execute",
    });
    // Second rejection — exceeds max_retries → failed
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "failed", retry_count: 2, max_retries: 1 })],
      bot_stats: { bot_0: { tasks_failed: 1 } },
      __node__: "partial_approval",
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
        makeTask({ task_id: "TASK-001", status: "reviewing" }),
        makeTask({ task_id: "TASK-002", status: "reviewing", assigned_to: "bot_1" }),
      ],
      __node__: "worker_execute",
    });
    // TASK-001 rejected, TASK-002 approved
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "needs_rework", reviewer_feedback: "HUMAN FEEDBACK: fix" }),
        makeTask({ task_id: "TASK-002", status: "completed", assigned_to: "bot_1" }),
      ],
      __node__: "partial_approval",
    });
    // Rework goes directly to worker_task (not coordinator), then back through pipeline
    mockWorkerExecuteNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "reviewing", retry_count: 1 }),
        makeTask({ task_id: "TASK-002", status: "completed", assigned_to: "bot_1" }),
      ],
      __node__: "worker_execute",
    });
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed", retry_count: 1 }),
        makeTask({ task_id: "TASK-002", status: "completed", assigned_to: "bot_1" }),
      ],
      __node__: "partial_approval",
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
      task_queue: [makeTask({ task_id: "TASK-001", status: "reviewing", max_retries: 0 })],
      __node__: "worker_execute",
    });
    // Human rejects and worker-bot logic marks as failed (max_retries exceeded)
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "failed", max_retries: 0, retry_count: 1 })],
      bot_stats: { bot_0: { tasks_failed: 1 } },
      __node__: "partial_approval",
    });

    const orch = createTeamOrchestration({ team: makeTeam() });
    const final = await simulateGraph(orch, orch.getInitialState({ userGoal: "Test" }));

    const task = (final.task_queue ?? []).find((t) => t.task_id === "TASK-001");
    expect(task?.status).toBe("failed");
  });
});
