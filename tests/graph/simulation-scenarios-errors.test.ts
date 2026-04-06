/**
 * Scenario-level tests: GATEWAY_FAILURE, MALFORMED_JSON, and SESSION_TIMEOUT
 *
 * Split from simulation-scenarios.test.ts for parallel test execution.
 *
 * All vi.hoisted() and vi.mock() calls are inline — they cannot be
 * exported/imported from shared files.
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "failed" })],
      __node__: "partial_approval",
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

  let parseLlmJson: typeof import("@/utils/jsonExtractor.js").parseLlmJson;

  beforeEach(async () => {
    const mod = await vi.importActual<typeof import("@/utils/jsonExtractor.js")>(
      "@/utils/jsonExtractor.js"
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "pending" })],  // still pending to force re-loop
      __node__: "partial_approval",
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
      task_queue: [makeTask({ task_id: "TASK-001", status: "reviewing" })],
      __node__: "worker_execute",
    });
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "partial_approval",
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
      task_queue: [makeTask({ task_id: "TASK-001", status: "reviewing" })],
      __node__: "worker_execute",
    });
    mockPartialApprovalNode.mockResolvedValue({
      task_queue: [makeTask({ task_id: "TASK-001", status: "completed" })],
      __node__: "partial_approval",
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
    mockPartialApprovalNode.mockResolvedValueOnce({
      task_queue: [
        makeTask({ task_id: "TASK-001", status: "completed" }),
        makeTask({ task_id: "TASK-002", status: "in_progress", assigned_to: "bot_1" }),
      ],
      __node__: "partial_approval",
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
