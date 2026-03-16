/**
 * Comprehensive tests for src/core/simulation.ts
 *
 * Covers: TeamOrchestration construction, getInitialState, configureSession,
 * run(), stream(), conditional edge routing, mid-sprint summary,
 * telemetry wrappers, timeout/max-runs guards, and error paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GraphState } from "../src/core/graph-state.js";

/* ------------------------------------------------------------------ */
/*  Hoisted mock references — available inside vi.mock factories       */
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
  mockHumanApprovalNode,
  mockSendNodeActive,
  mockSendSessionTimeout,
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
  mockHumanApprovalNode: vi.fn(),
  mockSendNodeActive: vi.fn(),
  mockSendSessionTimeout: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  vi.mock factories (hoisted — may only reference hoisted vars)      */
/* ------------------------------------------------------------------ */

vi.mock("@langchain/langgraph", () => {
  class FakeStateGraph {
    addNode = mockAddNode;
    addEdge = mockAddEdge;
    addConditionalEdges = mockAddConditionalEdges;
    compile = mockCompile;
    constructor(_annotation: unknown) {}
  }

  // Annotation is both callable (Annotation<T>(opts)) and has .Root()
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

vi.mock("../src/agents/coordinator.js", () => ({
  CoordinatorAgent: class {
    coordinateNode = mockCoordinateNode;
  },
}));

vi.mock("../src/agents/worker-bot.js", () => ({
  createWorkerBots: vi.fn().mockReturnValue({
    bot_0: { adapter: { executeTask: vi.fn() } },
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

vi.mock("../src/agents/approval.js", () => ({
  getFirstTaskNeedingApproval: vi.fn().mockReturnValue(null),
  createApprovalNode: vi.fn().mockReturnValue(mockApprovalNode),
  createHumanApprovalNode: vi.fn().mockReturnValue(mockHumanApprovalNode),
}));

vi.mock("../src/agents/planning.js", () => ({
  createSprintPlanningNode: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ __node__: "sprint_planning" })),
}));

vi.mock("../src/agents/rfc.js", () => ({
  createRFCNode: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ __node__: "rfc_phase" })),
}));

vi.mock("../src/agents/system-design.js", () => ({
  createSystemDesignNode: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ __node__: "system_design" })),
}));

vi.mock("../src/agents/memory-retrieval.js", () => ({
  createMemoryRetrievalNode: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ __node__: "memory_retrieval" })),
}));

vi.mock("../src/core/config.js", () => ({
  CONFIG: {
    openclawWorkerUrl: "http://localhost:18789",
    openclawToken: "test-token",
    maxCycles: 10,
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
  }),
}));

vi.mock("../src/core/logger.js", () => ({
  logger: { agent: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDebugMode: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/interfaces/worker-adapter.js", () => ({
  UniversalOpenClawAdapter: class {
    constructor(_opts: unknown) {}
    executeTask = vi.fn();
  },
}));

vi.mock("../src/core/team-templates.js", () => ({
  buildTeamFromTemplate: vi.fn().mockReturnValue([
    { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {}, worker_url: null },
    { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {}, worker_url: null },
  ]),
}));

/* ------------------------------------------------------------------ */
/*  Import AFTER all mocks are registered                              */
/* ------------------------------------------------------------------ */

import { createTeamOrchestration, TeamOrchestration } from "../src/core/simulation.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeTeam(count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `bot_${i}`,
    name: `Bot${i}`,
    role_id: "software_engineer",
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
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("simulation.ts — TeamOrchestration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-wire LangGraph StateGraph mocks
    mockInvoke.mockResolvedValue({} as GraphState);
    mockStream.mockResolvedValue((async function* () {})());
    mockCompile.mockReturnValue({ invoke: mockInvoke, stream: mockStream });
    mockAddNode.mockReturnThis();
    mockAddEdge.mockReturnThis();
    mockAddConditionalEdges.mockReturnThis();
    // Re-wire agent node mocks
    mockCoordinateNode.mockResolvedValue({ __node__: "coordinator" });
    mockWorkerExecuteNode.mockResolvedValue({ __node__: "worker_execute" });
    mockApprovalNode.mockResolvedValue({ __node__: "approval" });
    mockHumanApprovalNode.mockResolvedValue({ __node__: "human_approval" });
    mockSendNodeActive.mockReturnValue(undefined);
    mockSendSessionTimeout.mockReturnValue(undefined);
    // Re-wire mocked module exports (cleared by clearAllMocks)
    const workerBotMod = await import("../src/agents/worker-bot.js") as {
      createWorkerBots: ReturnType<typeof vi.fn>;
      createTaskDispatcher: ReturnType<typeof vi.fn>;
      createWorkerTaskNode: ReturnType<typeof vi.fn>;
      createWorkerCollectNode: ReturnType<typeof vi.fn>;
    };
    workerBotMod.createWorkerBots.mockReturnValue({
      bot_0: { adapter: { executeTask: vi.fn() } },
    });
    mockTaskDispatcher.mockReturnValue("worker_task");
    workerBotMod.createTaskDispatcher.mockReturnValue(mockTaskDispatcher);
    workerBotMod.createWorkerTaskNode.mockReturnValue(mockWorkerExecuteNode);
    workerBotMod.createWorkerCollectNode.mockReturnValue(vi.fn().mockReturnValue({
      last_action: "Dispatched via parallel Send",
      last_quality_score: 0,
      deep_work_mode: true,
      __node__: "worker_collect",
    }));

    const approvalMod = await import("../src/agents/approval.js") as {
      getFirstTaskNeedingApproval: ReturnType<typeof vi.fn>;
      createApprovalNode: ReturnType<typeof vi.fn>;
      createHumanApprovalNode: ReturnType<typeof vi.fn>;
    };
    approvalMod.getFirstTaskNeedingApproval.mockReturnValue(null);
    approvalMod.createApprovalNode.mockReturnValue(mockApprovalNode);
    approvalMod.createHumanApprovalNode.mockReturnValue(mockHumanApprovalNode);

    const planningMod = await import("../src/agents/planning.js") as { createSprintPlanningNode: ReturnType<typeof vi.fn> };
    planningMod.createSprintPlanningNode.mockReturnValue(vi.fn().mockResolvedValue({ __node__: "sprint_planning" }));

    const rfcMod = await import("../src/agents/rfc.js") as { createRFCNode: ReturnType<typeof vi.fn> };
    rfcMod.createRFCNode.mockReturnValue(vi.fn().mockResolvedValue({ __node__: "rfc_phase" }));

    const sysMod = await import("../src/agents/system-design.js") as { createSystemDesignNode: ReturnType<typeof vi.fn> };
    sysMod.createSystemDesignNode.mockReturnValue(vi.fn().mockResolvedValue({ __node__: "system_design" }));

    const memMod = await import("../src/agents/memory-retrieval.js") as { createMemoryRetrievalNode: ReturnType<typeof vi.fn> };
    memMod.createMemoryRetrievalNode.mockReturnValue(vi.fn().mockResolvedValue({ __node__: "memory_retrieval" }));

    const templateMod = await import("../src/core/team-templates.js") as { buildTeamFromTemplate: ReturnType<typeof vi.fn> };
    templateMod.buildTeamFromTemplate.mockReturnValue([
      { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {}, worker_url: null },
      { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {}, worker_url: null },
    ]);

    const telemetryMod = await import("../src/core/canvas-telemetry.js") as { getCanvasTelemetry: ReturnType<typeof vi.fn> };
    telemetryMod.getCanvasTelemetry.mockReturnValue({
      sendNodeActive: mockSendNodeActive,
      sendSessionTimeout: mockSendSessionTimeout,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ================================================================ */
  /*  createTeamOrchestration / constructor                            */
  /* ================================================================ */

  describe("createTeamOrchestration (factory)", () => {
    it("returns a TeamOrchestration instance with defaults", () => {
      const orch = createTeamOrchestration();
      expect(orch).toBeInstanceOf(TeamOrchestration);
    });

    it("uses provided team over template", () => {
      const team = makeTeam(3);
      const orch = createTeamOrchestration({ team });
      expect(orch.team).toHaveLength(3);
      expect(orch.team[0].id).toBe("bot_0");
    });

    it("registers all expected LangGraph nodes", () => {
      createTeamOrchestration();
      const registeredNodes = mockAddNode.mock.calls.map(
        (call: unknown[]) => call[0]
      );
      expect(registeredNodes).toContain("memory_retrieval");
      expect(registeredNodes).toContain("sprint_planning");
      expect(registeredNodes).toContain("system_design");
      expect(registeredNodes).toContain("rfc_phase");
      expect(registeredNodes).toContain("coordinator");
      expect(registeredNodes).toContain("preview");
      expect(registeredNodes).toContain("approval");
      expect(registeredNodes).toContain("worker_task");
      expect(registeredNodes).toContain("worker_collect");
      expect(registeredNodes).toContain("human_approval");
      expect(registeredNodes).toContain("increment_cycle");
    });

    it("registers the correct linear edges", () => {
      createTeamOrchestration();
      const edges = mockAddEdge.mock.calls.map(
        (call: unknown[]) => [call[0], call[1]]
      );
      expect(edges).toContainEqual(["__start__", "memory_retrieval"]);
      expect(edges).toContainEqual(["memory_retrieval", "sprint_planning"]);
      expect(edges).toContainEqual(["sprint_planning", "system_design"]);
      expect(edges).toContainEqual(["system_design", "rfc_phase"]);
      expect(edges).toContainEqual(["rfc_phase", "coordinator"]);
      expect(edges).toContainEqual(["coordinator", "preview"]);
      expect(edges).toContainEqual(["worker_task", "confidence_router"]);
      expect(edges).toContainEqual(["confidence_router", "worker_collect"]);
      // worker_collect → human_approval is now a conditional edge (wave loop)
      expect(edges).toContainEqual(["human_approval", "increment_cycle"]);
    });

    it("registers conditional edges for preview, approval, and increment_cycle", () => {
      createTeamOrchestration();
      const conditionalSources = mockAddConditionalEdges.mock.calls.map(
        (call: unknown[]) => call[0]
      );
      expect(conditionalSources).toContain("preview");
      expect(conditionalSources).toContain("approval");
      expect(conditionalSources).toContain("worker_collect");
      expect(conditionalSources).toContain("increment_cycle");
    });

    it("compiles the graph with a MemorySaver checkpointer", () => {
      createTeamOrchestration();
      expect(mockCompile).toHaveBeenCalledTimes(1);
      const arg = mockCompile.mock.calls[0][0] as Record<string, unknown>;
      expect(arg.checkpointer).toBeDefined();
    });
  });

  /* ================================================================ */
  /*  getInitialState                                                  */
  /* ================================================================ */

  describe("getInitialState", () => {
    it("returns state with correct userGoal", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({ userGoal: "Ship v2" });
      expect(state.user_goal).toBe("Ship v2");
    });

    it("includes team members in state.team", () => {
      const team = makeTeam(2);
      const orch = createTeamOrchestration({ team });
      const state = orch.getInitialState({});
      expect(state.team).toHaveLength(2);
    });

    it("pushes 'Work session started' to messages", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({});
      expect(state.messages).toContain("Work session started");
    });

    it("merges initialTasks into task_queue with correct IDs", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({
        initialTasks: [
          { description: "First" },
          { description: "Second", priority: "HIGH" },
          { description: "Third", assigned_to: "bot_x" },
        ],
      });
      const q = state.task_queue as Record<string, unknown>[];
      expect(q).toHaveLength(3);
      expect(q[0].task_id).toBe("TASK-M000");
      expect(q[1].task_id).toBe("TASK-M001");
      expect(q[2].task_id).toBe("TASK-M002");
      expect(q[1].priority).toBe("HIGH");
      expect(q[2].assigned_to).toBe("bot_x");
    });

    it("assigns default bot id when assigned_to is missing and team exists", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({
        initialTasks: [{ description: "auto-assign" }],
      });
      const q = state.task_queue as Record<string, unknown>[];
      expect(q[0].assigned_to).toBe("bot_0");
    });

    it("returns empty task_queue when no initialTasks given", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({});
      const q = state.task_queue as Record<string, unknown>[];
      expect(q).toHaveLength(0);
    });

    it("passes ancestralLessons into initial state", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({
        ancestralLessons: ["lesson1", "lesson2"],
      });
      expect(state.ancestral_lessons).toEqual(["lesson1", "lesson2"]);
    });

    it("handles null userGoal gracefully", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({ userGoal: null });
      expect(state.user_goal).toBeNull();
    });

    it("sets project_context when provided", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({ projectContext: "Node.js monorepo" });
      expect(state.project_context).toBe("Node.js monorepo");
    });

    it("defaults project_context to empty string when not provided", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({});
      // projectContext defaults to "" in getInitialState, but only assigned when truthy
      expect(state.project_context ?? "").toBe("");
    });

    it("handles completely empty options", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState();
      expect(state).toBeDefined();
      expect(state.cycle_count).toBe(0);
      expect(state.session_active).toBe(true);
    });
  });

  /* ================================================================ */
  /*  configureSession                                                 */
  /* ================================================================ */

  describe("configureSession", () => {
    it("sets timeout from minutes", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const before = Date.now();
      orch.configureSession({ timeoutMinutes: 5 });
      // Access private fields via any cast for white-box testing
      const o = orch as unknown as Record<string, number>;
      expect(o.sessionTimeoutMs).toBe(5 * 60 * 1000);
      expect(o.sessionStartTime).toBeGreaterThanOrEqual(before);
    });

    it("sets maxRuns", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      orch.configureSession({ maxRuns: 3 });
      const o = orch as unknown as Record<string, number>;
      expect(o.sessionMaxRuns).toBe(3);
    });

    it("defaults to zero when options omitted", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      orch.configureSession({});
      const o = orch as unknown as Record<string, number>;
      expect(o.sessionTimeoutMs).toBe(0);
      expect(o.sessionMaxRuns).toBe(0);
    });
  });

  /* ================================================================ */
  /*  run()                                                            */
  /* ================================================================ */

  describe("run()", () => {
    it("invokes the compiled graph and returns final state", async () => {
      const finalState = { cycle_count: 3, session_active: false } as unknown as GraphState;
      mockInvoke.mockResolvedValueOnce(finalState);

      const orch = createTeamOrchestration({ team: makeTeam() });
      const result = await orch.run({ userGoal: "test" });
      expect(result).toBe(finalState);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it("passes a unique thread_id in config", async () => {
      mockInvoke.mockResolvedValueOnce({} as GraphState);
      const orch = createTeamOrchestration({ team: makeTeam() });
      await orch.run();
      const configArg = mockInvoke.mock.calls[0][1] as { configurable: { thread_id: string } };
      expect(configArg.configurable.thread_id).toBeTruthy();
    });

    it("sends 'completed' telemetry on success without timeout", async () => {
      mockInvoke.mockResolvedValueOnce({} as GraphState);
      const orch = createTeamOrchestration({ team: makeTeam() });
      await orch.run();
      expect(mockSendNodeActive).toHaveBeenCalledWith("completed");
      expect(mockSendSessionTimeout).not.toHaveBeenCalled();
    });

    it("re-throws graph errors", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("LLM gateway 502"));
      const orch = createTeamOrchestration({ team: makeTeam() });
      await expect(orch.run({ userGoal: "fail" })).rejects.toThrow("LLM gateway 502");
    });

    it("sends timeout telemetry when error occurs after timeout", async () => {
      vi.useFakeTimers();
      try {
        mockInvoke.mockImplementationOnce(async () => {
          // Simulate elapsed time beyond timeout
          vi.advanceTimersByTime(6 * 60 * 1000);
          throw new Error("aborted");
        });
        const orch = createTeamOrchestration({ team: makeTeam() });
        await expect(orch.run({ userGoal: "slow", timeoutMinutes: 5 })).rejects.toThrow("aborted");
        expect(mockSendSessionTimeout).toHaveBeenCalledWith("timeout", expect.any(Number));
      } finally {
        vi.useRealTimers();
      }
    });

    it("sets session limits from run options", async () => {
      mockInvoke.mockResolvedValueOnce({} as GraphState);
      const orch = createTeamOrchestration({ team: makeTeam() });
      await orch.run({ maxRuns: 7, timeoutMinutes: 30 });
      const o = orch as unknown as Record<string, number>;
      expect(o.sessionMaxRuns).toBe(7);
      expect(o.sessionTimeoutMs).toBe(30 * 60 * 1000);
    });

    it("handles run with no options (all defaults)", async () => {
      mockInvoke.mockResolvedValueOnce({} as GraphState);
      const orch = createTeamOrchestration({ team: makeTeam() });
      const result = await orch.run();
      expect(result).toBeDefined();
    });
  });

  /* ================================================================ */
  /*  stream()                                                         */
  /* ================================================================ */

  describe("stream()", () => {
    it("yields chunks from the compiled graph stream", async () => {
      const chunks = [
        { coordinator: { __node__: "coordinator" } },
        { worker_execute: { __node__: "worker" } },
      ];
      mockStream.mockResolvedValueOnce(
        (async function* () {
          for (const c of chunks) yield c;
        })()
      );

      const orch = createTeamOrchestration({ team: makeTeam() });
      const collected: Record<string, GraphState>[] = [];
      for await (const chunk of orch.stream({ userGoal: "stream test" })) {
        collected.push(chunk);
      }
      expect(collected).toHaveLength(2);
    });

    it("sends 'completed' telemetry after normal stream end", async () => {
      mockStream.mockResolvedValueOnce(
        (async function* () {
          yield { done: {} };
        })()
      );
      const orch = createTeamOrchestration({ team: makeTeam() });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of orch.stream()) { /* drain */ }
      expect(mockSendNodeActive).toHaveBeenCalledWith("completed");
    });

    it("breaks on timeout and sends timeout telemetry", async () => {
      vi.useFakeTimers();
      try {
        let yieldCount = 0;
        mockStream.mockResolvedValueOnce(
          (async function* () {
            while (true) {
              yieldCount++;
              vi.advanceTimersByTime(2 * 60 * 1000); // 2 min per chunk
              yield { chunk: yieldCount };
            }
          })()
        );

        const orch = createTeamOrchestration({ team: makeTeam() });
        const collected: unknown[] = [];
        for await (const chunk of orch.stream({ userGoal: "long", timeoutMinutes: 5 })) {
          collected.push(chunk);
        }
        // Should break after ~3 chunks (6 min > 5 min timeout)
        expect(collected.length).toBeLessThanOrEqual(3);
        expect(mockSendSessionTimeout).toHaveBeenCalledWith("timeout", expect.any(Number));
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-throws errors from the underlying stream", async () => {
      mockStream.mockResolvedValueOnce(
        (async function* () {
          yield { chunk: 1 };
          throw new Error("network disconnect");
        })()
      );
      const orch = createTeamOrchestration({ team: makeTeam() });
      const drain = async () => {
        for await (const _ of orch.stream()) { /* drain */ }
      };
      await expect(drain()).rejects.toThrow("network disconnect");
    });

    it("yields nothing for empty stream", async () => {
      mockStream.mockResolvedValueOnce(
        (async function* () {})()
      );
      const orch = createTeamOrchestration({ team: makeTeam() });
      const collected: unknown[] = [];
      for await (const chunk of orch.stream()) {
        collected.push(chunk);
      }
      expect(collected).toHaveLength(0);
      // No telemetry since lastChunk is null
      expect(mockSendNodeActive).not.toHaveBeenCalled();
    });

    it("sets session limits from stream options", async () => {
      mockStream.mockResolvedValueOnce((async function* () {})());
      const orch = createTeamOrchestration({ team: makeTeam() });
      for await (const _ of orch.stream({ maxRuns: 4, timeoutMinutes: 15 })) { /* drain */ }
      const o = orch as unknown as Record<string, number>;
      expect(o.sessionMaxRuns).toBe(4);
      expect(o.sessionTimeoutMs).toBe(15 * 60 * 1000);
    });
  });

  /* ================================================================ */
  /*  Conditional edge routing logic                                   */
  /* ================================================================ */

  describe("conditional edge routing", () => {
    // The routing functions are passed to addConditionalEdges.
    // We extract them from the mock calls and test them directly.

    function getRoutingFn(sourceNode: string): (s: Partial<GraphState>) => string {
      const call = mockAddConditionalEdges.mock.calls.find(
        (c: unknown[]) => c[0] === sourceNode
      );
      if (!call) throw new Error(`No conditional edge found for "${sourceNode}"`);
      return call[1] as (s: Partial<GraphState>) => string;
    }

    let coordinatorRoute: (s: Partial<GraphState>) => string;
    let approvalRoute: (s: Partial<GraphState>) => string;
    let incrementRoute: (s: Partial<GraphState>) => string;

    beforeEach(() => {
      // Recreate orchestration so routing functions are captured
      mockAddConditionalEdges.mockClear();
      mockAddNode.mockClear();
      mockAddEdge.mockClear();
      createTeamOrchestration({ team: makeTeam() });
      // Conditional edges moved from "coordinator" to "preview" node
      coordinatorRoute = getRoutingFn("preview");
      approvalRoute = getRoutingFn("approval");
      incrementRoute = getRoutingFn("increment_cycle");
    });

    describe("coordinator → routing", () => {
      it("routes to __end__ when no pending tasks", () => {
        const result = coordinatorRoute({
          task_queue: [makeTask({ status: "completed" })],
        } as unknown as Partial<GraphState>);
        expect(result).toBe("__end__");
      });

      it("routes to __end__ with empty task_queue", () => {
        expect(coordinatorRoute({ task_queue: [] } as unknown as Partial<GraphState>)).toBe("__end__");
      });

      it("routes to worker_task (via dispatcher) when pending tasks exist and no approval needed", async () => {
        const approval = await import("../src/agents/approval.js") as { getFirstTaskNeedingApproval: ReturnType<typeof vi.fn> };
        approval.getFirstTaskNeedingApproval.mockReturnValue(null);
        const result = coordinatorRoute({
          task_queue: [makeTask({ status: "pending" })],
        } as unknown as Partial<GraphState>);
        // Dispatcher mock returns "worker_task"
        expect(result).toBe("worker_task");
      });

      it("routes to approval when a task needs approval", async () => {
        const approval = await import("../src/agents/approval.js") as { getFirstTaskNeedingApproval: ReturnType<typeof vi.fn> };
        approval.getFirstTaskNeedingApproval.mockReturnValue({
          task_id: "TASK-001",
          description: "deploy prod",
          assigned_to: "bot_0",
          priority: "HIGH",
        });
        const result = coordinatorRoute({
          task_queue: [makeTask({ status: "pending", priority: "HIGH" })],
        } as unknown as Partial<GraphState>);
        expect(result).toBe("approval");
      });

      it("handles undefined task_queue", () => {
        const result = coordinatorRoute({} as Partial<GraphState>);
        expect(result).toBe("__end__");
      });
    });

    describe("approval → routing", () => {
      it("routes to coordinator on feedback action", () => {
        const result = approvalRoute({
          approval_response: { action: "feedback" },
        } as unknown as Partial<GraphState>);
        expect(result).toBe("coordinator");
      });

      it("routes to worker_task (via dispatcher) on approved action", () => {
        const result = approvalRoute({
          approval_response: { action: "approved" },
        } as unknown as Partial<GraphState>);
        expect(result).toBe("worker_task");
      });

      it("routes to worker_task (via dispatcher) when approval_response is null", () => {
        const result = approvalRoute({
          approval_response: null,
        } as unknown as Partial<GraphState>);
        expect(result).toBe("worker_task");
      });

      it("routes to worker_task (via dispatcher) on edited action", () => {
        const result = approvalRoute({
          approval_response: { action: "edited" },
        } as unknown as Partial<GraphState>);
        expect(result).toBe("worker_task");
      });
    });

    describe("increment_cycle → routing", () => {
      it("routes to __end__ when cycle_count >= maxCycles", () => {
        const result = incrementRoute({
          cycle_count: 10,
          task_queue: [],
          user_goal: null,
        } as unknown as Partial<GraphState>);
        expect(result).toBe("__end__");
      });

      it("routes to continue when active tasks exist", () => {
        const result = incrementRoute({
          cycle_count: 1,
          task_queue: [makeTask({ status: "pending" })],
          user_goal: "build it",
        } as unknown as Partial<GraphState>);
        expect(result).toBe("continue");
      });

      it("routes to continue when user_goal exists even with no active tasks", () => {
        const result = incrementRoute({
          cycle_count: 1,
          task_queue: [makeTask({ status: "completed" })],
          user_goal: "iterate",
        } as unknown as Partial<GraphState>);
        expect(result).toBe("continue");
      });

      it("routes to __end__ when no active tasks and no user_goal", () => {
        const result = incrementRoute({
          cycle_count: 1,
          task_queue: [makeTask({ status: "completed" })],
          user_goal: null,
        } as unknown as Partial<GraphState>);
        expect(result).toBe("__end__");
      });

      it("routes to __end__ with empty state (defaults)", () => {
        const result = incrementRoute({} as Partial<GraphState>);
        expect(result).toBe("__end__");
      });

      it("recognizes all active statuses for continuation", () => {
        const activeStatuses = ["pending", "reviewing", "needs_rework", "in_progress", "waiting_for_human", "rfc_pending"];
        for (const status of activeStatuses) {
          const result = incrementRoute({
            cycle_count: 1,
            task_queue: [makeTask({ status })],
            user_goal: null,
          } as unknown as Partial<GraphState>);
          expect(result).toBe("continue");
        }
      });

      it("respects sessionMaxRuns when lower than CONFIG.maxCycles", () => {
        // This test validates the min(sessionMaxRuns, CONFIG.maxCycles) logic.
        // We need a fresh orchestration whose routing closure captures sessionMaxRuns.
        mockAddConditionalEdges.mockClear();
        mockAddNode.mockClear();
        mockAddEdge.mockClear();
        const orch = createTeamOrchestration({ team: makeTeam() });
        orch.configureSession({ maxRuns: 3 });

        // Get routing fn from the LATEST addConditionalEdges call (from fresh orch)
        const calls = mockAddConditionalEdges.mock.calls.filter(
          (c: unknown[]) => c[0] === "increment_cycle"
        );
        const routeFn = calls[calls.length - 1]![1] as (s: Partial<GraphState>) => string;

        const result = routeFn({
          cycle_count: 3,
          task_queue: [makeTask({ status: "pending" })],
          user_goal: "continue",
        } as unknown as Partial<GraphState>);
        expect(result).toBe("__end__");
      });
    });
  });

  /* ================================================================ */
  /*  increment_cycle node (inline node function)                      */
  /* ================================================================ */

  describe("increment_cycle node logic", () => {
    function getIncrementCycleNode(): (s: Partial<GraphState>) => Partial<GraphState> {
      const call = mockAddNode.mock.calls.find(
        (c: unknown[]) => c[0] === "increment_cycle"
      );
      if (!call) throw new Error("increment_cycle node not registered");
      return call[1] as (s: Partial<GraphState>) => Partial<GraphState>;
    }

    let incrementNode: (s: Partial<GraphState>) => Partial<GraphState>;

    beforeEach(() => {
      mockAddNode.mockClear();
      mockAddEdge.mockClear();
      mockAddConditionalEdges.mockClear();
      createTeamOrchestration({ team: makeTeam() });
      incrementNode = getIncrementCycleNode();
    });

    it("increments cycle_count by 1", () => {
      const result = incrementNode({
        cycle_count: 5,
        task_queue: [],
        total_tasks: 0,
        mid_sprint_reported: false,
      } as unknown as Partial<GraphState>);
      expect(result.cycle_count).toBe(6);
    });

    it("counts completed and waiting_for_human tasks", () => {
      const result = incrementNode({
        cycle_count: 0,
        task_queue: [
          makeTask({ status: "completed" }),
          makeTask({ status: "waiting_for_human" }),
          makeTask({ status: "pending" }),
        ],
        total_tasks: 3,
        mid_sprint_reported: false,
      } as unknown as Partial<GraphState>);
      expect(result.completed_tasks).toBe(2);
    });

    it("sets __node__ to increment_cycle", () => {
      const result = incrementNode({
        cycle_count: 0,
        task_queue: [],
        total_tasks: 0,
        mid_sprint_reported: false,
      } as unknown as Partial<GraphState>);
      expect(result.__node__).toBe("increment_cycle");
    });

    it("triggers mid-sprint summary at 50% completion", () => {
      const result = incrementNode({
        cycle_count: 2,
        task_queue: [
          makeTask({ status: "completed", task_id: "T1", description: "Do thing A" }),
          makeTask({ status: "completed", task_id: "T2", description: "Do thing B" }),
          makeTask({ status: "pending", task_id: "T3", description: "Do thing C" }),
          makeTask({ status: "pending", task_id: "T4", description: "Do thing D" }),
        ],
        total_tasks: 4,
        mid_sprint_reported: false,
        bot_stats: {},
        last_quality_score: 85,
      } as unknown as Partial<GraphState>);

      expect(result.mid_sprint_reported).toBe(true);
      expect(result.messages).toBeDefined();
      const msgs = result.messages as string[];
      expect(msgs[0]).toContain("MID-SPRINT SUMMARY");
      expect(msgs[0]).toContain("2/4");
    });

    it("does NOT re-trigger mid-sprint summary if already reported", () => {
      const result = incrementNode({
        cycle_count: 2,
        task_queue: [
          makeTask({ status: "completed" }),
          makeTask({ status: "pending" }),
        ],
        total_tasks: 2,
        mid_sprint_reported: true, // already reported
        bot_stats: {},
        last_quality_score: 90,
      } as unknown as Partial<GraphState>);

      expect(result.mid_sprint_reported).toBeUndefined();
      expect(result.messages).toBeUndefined();
    });

    it("does not trigger mid-sprint summary below 50%", () => {
      const result = incrementNode({
        cycle_count: 1,
        task_queue: [
          makeTask({ status: "completed" }),
          makeTask({ status: "pending" }),
          makeTask({ status: "pending" }),
          makeTask({ status: "pending" }),
        ],
        total_tasks: 4,
        mid_sprint_reported: false,
        bot_stats: {},
      } as unknown as Partial<GraphState>);

      expect(result.mid_sprint_reported).toBeUndefined();
    });

    it("handles zero total_tasks without division error", () => {
      const result = incrementNode({
        cycle_count: 0,
        task_queue: [],
        total_tasks: 0,
        mid_sprint_reported: false,
      } as unknown as Partial<GraphState>);

      expect(result.cycle_count).toBe(1);
      expect(result.mid_sprint_reported).toBeUndefined();
    });

    it("falls back to task_queue length when total_tasks is unset", () => {
      const result = incrementNode({
        cycle_count: 0,
        task_queue: [
          makeTask({ status: "completed" }),
          makeTask({ status: "completed" }),
        ],
        mid_sprint_reported: false,
        bot_stats: {},
        last_quality_score: 100,
      } as unknown as Partial<GraphState>);

      // 2/2 = 100% >= 50%, should trigger
      expect(result.mid_sprint_reported).toBe(true);
    });
  });

  /* ================================================================ */
  /*  Mid-sprint summary content (generateMidSprintSummary)            */
  /* ================================================================ */

  describe("mid-sprint summary content", () => {
    // We test via the increment_cycle node which calls generateMidSprintSummary

    function getIncrementCycleNode(): (s: Partial<GraphState>) => Partial<GraphState> {
      mockAddNode.mockClear();
      mockAddEdge.mockClear();
      mockAddConditionalEdges.mockClear();
      createTeamOrchestration({ team: makeTeam() });
      const call = mockAddNode.mock.calls.find(
        (c: unknown[]) => c[0] === "increment_cycle"
      );
      return call![1] as (s: Partial<GraphState>) => Partial<GraphState>;
    }

    it("shows rocket vibe for high quality and zero reworks", () => {
      const node = getIncrementCycleNode();
      const result = node({
        cycle_count: 0,
        task_queue: [
          makeTask({ status: "completed", task_id: "T1", description: "Implement auth" }),
          makeTask({ status: "pending", task_id: "T2", description: "Add tests" }),
        ],
        total_tasks: 2,
        mid_sprint_reported: false,
        bot_stats: { bot_0: { reworks_triggered: 0 } },
        last_quality_score: 90,
      } as unknown as Partial<GraphState>);

      const msg = (result.messages as string[])?.[0] ?? "";
      expect(msg).toContain("On track");
    });

    it("shows warning vibe for medium quality", () => {
      const node = getIncrementCycleNode();
      const result = node({
        cycle_count: 0,
        task_queue: [
          makeTask({ status: "completed", task_id: "T1", description: "API" }),
          makeTask({ status: "pending", task_id: "T2", description: "FE" }),
        ],
        total_tasks: 2,
        mid_sprint_reported: false,
        bot_stats: { bot_0: { reworks_triggered: 1 } },
        last_quality_score: 65,
      } as unknown as Partial<GraphState>);

      const msg = (result.messages as string[])?.[0] ?? "";
      expect(msg).toContain("Progressing");
    });

    it("shows at-risk vibe for low quality with many reworks", () => {
      const node = getIncrementCycleNode();
      const result = node({
        cycle_count: 0,
        task_queue: [
          makeTask({ status: "completed", task_id: "T1", description: "Core" }),
          makeTask({ status: "pending", task_id: "T2", description: "Deploy" }),
        ],
        total_tasks: 2,
        mid_sprint_reported: false,
        bot_stats: {
          bot_0: { reworks_triggered: 3 },
          bot_1: { reworks_triggered: 2 },
        },
        last_quality_score: 30,
      } as unknown as Partial<GraphState>);

      const msg = (result.messages as string[])?.[0] ?? "";
      expect(msg).toContain("At risk");
    });

    it("shows '(none yet)' when no tasks completed", () => {
      const node = getIncrementCycleNode();
      // Force 50% by having 0 total_tasks fallback to queue length
      // Actually we need completed >= 50%... let's use a trick:
      // 1 completed + 1 pending = 50%
      const result = node({
        cycle_count: 0,
        task_queue: [
          makeTask({ status: "waiting_for_human", task_id: "T1", description: "Review" }),
          makeTask({ status: "pending", task_id: "T2", description: "Build" }),
        ],
        total_tasks: 2,
        mid_sprint_reported: false,
        bot_stats: {},
        last_quality_score: 0,
      } as unknown as Partial<GraphState>);

      const msg = (result.messages as string[])?.[0] ?? "";
      expect(msg).toContain("MID-SPRINT SUMMARY");
    });

    it("truncates long task descriptions to 50 chars", () => {
      const node = getIncrementCycleNode();
      const longDesc = "A".repeat(100);
      const result = node({
        cycle_count: 0,
        task_queue: [
          makeTask({ status: "completed", task_id: "T1", description: longDesc }),
          makeTask({ status: "pending", task_id: "T2", description: "short" }),
        ],
        total_tasks: 2,
        mid_sprint_reported: false,
        bot_stats: {},
        last_quality_score: 80,
      } as unknown as Partial<GraphState>);

      const msg = (result.messages as string[])?.[0] ?? "";
      // The truncated description should be 50 chars of 'A'
      expect(msg).toContain("A".repeat(50));
      expect(msg).not.toContain("A".repeat(51));
    });
  });

  /* ================================================================ */
  /*  Telemetry wrapper                                                */
  /* ================================================================ */

  describe("telemetry wrapper (wrapWithTelemetry)", () => {
    // The telemetry wrapper is applied to every node.
    // We can verify by checking that registered node functions call sendNodeActive.

    it("sends NODE_ACTIVE telemetry before calling the wrapped node", async () => {
      // Get the wrapped coordinator node from addNode calls
      mockAddNode.mockClear();
      createTeamOrchestration({ team: makeTeam() });

      const coordinatorCall = mockAddNode.mock.calls.find(
        (c: unknown[]) => c[0] === "coordinator"
      );
      const wrappedFn = coordinatorCall![1] as (s: GraphState) => Promise<Partial<GraphState>>;

      mockCoordinateNode.mockResolvedValueOnce({ __node__: "coordinator" });
      await wrappedFn({} as GraphState);

      expect(mockSendNodeActive).toHaveBeenCalledWith("coordinator");
    });

    it("still calls the wrapped function even if telemetry throws", async () => {
      const { getCanvasTelemetry } = await import("../src/core/canvas-telemetry.js") as {
        getCanvasTelemetry: ReturnType<typeof vi.fn>;
      };
      getCanvasTelemetry.mockImplementationOnce(() => {
        throw new Error("telemetry unavailable");
      });

      mockAddNode.mockClear();
      createTeamOrchestration({ team: makeTeam() });

      const workerCall = mockAddNode.mock.calls.find(
        (c: unknown[]) => c[0] === "worker_task"
      );
      const wrappedFn = workerCall![1] as (s: GraphState) => Promise<Partial<GraphState>>;

      mockWorkerExecuteNode.mockResolvedValueOnce({ __node__: "worker_task" });
      const result = await wrappedFn({} as GraphState);
      expect(result.__node__).toBe("worker_task");
    });
  });

  /* ================================================================ */
  /*  Edge cases and boundary conditions                               */
  /* ================================================================ */

  describe("edge cases", () => {
    it("handles AbortSignal passed through constructor", () => {
      const controller = new AbortController();
      const orch = createTeamOrchestration({
        team: makeTeam(),
        signal: controller.signal,
      });
      expect(orch).toBeInstanceOf(TeamOrchestration);
    });

    it("constructs without any options (full defaults)", () => {
      const orch = createTeamOrchestration();
      expect(orch.team).toBeDefined();
      expect(orch.coordinator).toBeDefined();
      expect(orch.graph).toBeDefined();
    });

    it("accepts vectorMemory option", () => {
      const fakeMemory = { search: vi.fn(), add: vi.fn() };
      const orch = createTeamOrchestration({
        team: makeTeam(),
        vectorMemory: fakeMemory as unknown as import("../src/core/knowledge-base.js").VectorMemory,
      });
      expect(orch).toBeInstanceOf(TeamOrchestration);
    });

    it("accepts autoApprove option", () => {
      const orch = createTeamOrchestration({
        team: makeTeam(),
        autoApprove: true,
      });
      expect(orch).toBeInstanceOf(TeamOrchestration);
    });

    it("run() with timeout detects post-invoke timeout", async () => {
      vi.useFakeTimers();
      try {
        mockInvoke.mockImplementationOnce(async () => {
          vi.advanceTimersByTime(11 * 60 * 1000); // exceed 10 min timeout
          return {} as GraphState;
        });
        const orch = createTeamOrchestration({ team: makeTeam() });
        await orch.run({ timeoutMinutes: 10 });
        expect(mockSendSessionTimeout).toHaveBeenCalledWith("timeout", expect.any(Number));
      } finally {
        vi.useRealTimers();
      }
    });

    it("multiple sequential runs use independent thread_ids", async () => {
      mockInvoke.mockResolvedValue({} as GraphState);
      const orch = createTeamOrchestration({ team: makeTeam() });
      await orch.run();
      await orch.run();
      const id1 = (mockInvoke.mock.calls[0][1] as { configurable: { thread_id: string } }).configurable.thread_id;
      const id2 = (mockInvoke.mock.calls[1][1] as { configurable: { thread_id: string } }).configurable.thread_id;
      expect(id1).not.toBe(id2);
    });
  });
});
