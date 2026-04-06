/**
 * Construction & State tests for simulation.ts
 *
 * Covers: createTeamOrchestration factory, getInitialState, configureSession.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GraphState } from "@/core/graph-state.js";

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
  mockPartialApprovalNode,
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
  mockPartialApprovalNode: vi.fn(),
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

vi.mock("@/agents/coordinator.js", () => ({
  CoordinatorAgent: class {
    coordinateNode = mockCoordinateNode;
  },
}));

vi.mock("@/agents/worker-bot.js", () => ({
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

vi.mock("@/agents/approval.js", () => ({
  getFirstTaskNeedingApproval: vi.fn().mockReturnValue(null),
  createApprovalNode: vi.fn().mockReturnValue(mockApprovalNode),
}));

vi.mock("@/agents/partial-approval.js", () => ({
  createPartialApprovalNode: vi.fn().mockReturnValue(mockPartialApprovalNode),
}));

vi.mock("@/agents/planning.js", () => ({
  createSprintPlanningNode: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ __node__: "sprint_planning" })),
}));

vi.mock("@/agents/rfc.js", () => ({
  createRFCNode: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ __node__: "rfc_phase" })),
}));

vi.mock("@/agents/system-design.js", () => ({
  createSystemDesignNode: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ __node__: "system_design" })),
}));

vi.mock("@/agents/memory-retrieval.js", () => ({
  createMemoryRetrievalNode: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ __node__: "memory_retrieval" })),
}));

vi.mock("@/core/config.js", () => ({
  CONFIG: {
    maxCycles: 10,
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
  }),
}));

vi.mock("@/core/logger.js", () => ({
  logger: { agent: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDebugMode: vi.fn().mockReturnValue(false),
}));

vi.mock("@/interfaces/worker-adapter.js", () => ({
  UniversalWorkerAdapter: class {
    constructor(_opts: unknown) {}
    executeTask = vi.fn();
  },
}));

vi.mock("@/core/team-templates.js", () => ({
  buildTeamFromTemplate: vi.fn().mockReturnValue([
    { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {}, worker_url: null },
    { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {}, worker_url: null },
  ]),
}));

/* ------------------------------------------------------------------ */
/*  Import AFTER all mocks are registered                              */
/* ------------------------------------------------------------------ */

import { createTeamOrchestration, TeamOrchestration } from "@/core/simulation.js";
import { makeTeam, makeTask } from "./simulation-test-utils.js";

/* ================================================================== */
/*  Test suite                                                         */
/* ================================================================== */

describe("simulation.ts — Construction & State", () => {
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
    mockPartialApprovalNode.mockResolvedValue({ __node__: "partial_approval" });
    mockSendNodeActive.mockReturnValue(undefined);
    mockSendSessionTimeout.mockReturnValue(undefined);
    // Re-wire mocked module exports (cleared by clearAllMocks)
    const workerBotMod = await import("@/agents/worker-bot.js") as {
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

    const approvalMod = await import("@/agents/approval.js") as {
      getFirstTaskNeedingApproval: ReturnType<typeof vi.fn>;
      createApprovalNode: ReturnType<typeof vi.fn>;
    };
    approvalMod.getFirstTaskNeedingApproval.mockReturnValue(null);
    approvalMod.createApprovalNode.mockReturnValue(mockApprovalNode);
    const partialApprovalMod = await import("@/agents/partial-approval.js") as { createPartialApprovalNode: ReturnType<typeof vi.fn> };
    partialApprovalMod.createPartialApprovalNode.mockReturnValue(mockPartialApprovalNode);

    const planningMod = await import("@/agents/planning.js") as { createSprintPlanningNode: ReturnType<typeof vi.fn> };
    planningMod.createSprintPlanningNode.mockReturnValue(vi.fn().mockResolvedValue({ __node__: "sprint_planning" }));

    const rfcMod = await import("@/agents/rfc.js") as { createRFCNode: ReturnType<typeof vi.fn> };
    rfcMod.createRFCNode.mockReturnValue(vi.fn().mockResolvedValue({ __node__: "rfc_phase" }));

    const sysMod = await import("@/agents/system-design.js") as { createSystemDesignNode: ReturnType<typeof vi.fn> };
    sysMod.createSystemDesignNode.mockReturnValue(vi.fn().mockResolvedValue({ __node__: "system_design" }));

    const memMod = await import("@/agents/memory-retrieval.js") as { createMemoryRetrievalNode: ReturnType<typeof vi.fn> };
    memMod.createMemoryRetrievalNode.mockReturnValue(vi.fn().mockResolvedValue({ __node__: "memory_retrieval" }));

    const templateMod = await import("@/core/team-templates.js") as { buildTeamFromTemplate: ReturnType<typeof vi.fn> };
    templateMod.buildTeamFromTemplate.mockReturnValue([
      { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {}, worker_url: null },
      { id: "bot_1", name: "QA", role_id: "qa_reviewer", traits: {}, worker_url: null },
    ]);

    const telemetryMod = await import("@/core/canvas-telemetry.js") as { getCanvasTelemetry: ReturnType<typeof vi.fn> };
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
      expect(registeredNodes).toContain("preview_gate");
      expect(registeredNodes).toContain("approval");
      expect(registeredNodes).toContain("worker_task");
      expect(registeredNodes).toContain("worker_collect");
      expect(registeredNodes).toContain("partial_approval");
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
      // coordinator -> preview_gate is now a conditional edge (replanning loop)
      expect(edges).toContainEqual(["worker_task", "confidence_router"]);
      expect(edges).toContainEqual(["confidence_router", "worker_collect"]);
      // partial_approval -> increment_cycle is now a conditional edge (rework loop)
    });

    it("registers conditional edges for preview, approval, and increment_cycle", () => {
      createTeamOrchestration();
      const conditionalSources = mockAddConditionalEdges.mock.calls.map(
        (call: unknown[]) => call[0]
      );
      expect(conditionalSources).toContain("coordinator");
      expect(conditionalSources).toContain("preview_gate");
      expect(conditionalSources).toContain("approval");
      expect(conditionalSources).toContain("worker_collect");
      expect(conditionalSources).toContain("partial_approval");
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

    it("includes run start message", () => {
      const orch = createTeamOrchestration({ team: makeTeam() });
      const state = orch.getInitialState({ runId: 2 });
      expect(state.messages).toContain("OpenPawl - Run 2 started");
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
});
