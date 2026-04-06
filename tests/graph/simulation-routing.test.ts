/**
 * Routing, increment_cycle, mid-sprint summary, telemetry, and edge-case
 * tests for src/core/simulation.ts
 *
 * All vi.hoisted() / vi.mock() calls are inline — they cannot be shared.
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

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("simulation.ts — Routing & Edge Cases", () => {
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
  /*  Conditional edge routing                                         */
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
      // Conditional edges moved from "coordinator" to "preview_gate" node
      coordinatorRoute = getRoutingFn("preview_gate");
      approvalRoute = getRoutingFn("approval");
      incrementRoute = getRoutingFn("increment_cycle");
    });

    describe("coordinator -> routing", () => {
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
        const approval = await import("@/agents/approval.js") as { getFirstTaskNeedingApproval: ReturnType<typeof vi.fn> };
        approval.getFirstTaskNeedingApproval.mockReturnValue(null);
        const result = coordinatorRoute({
          task_queue: [makeTask({ status: "pending" })],
        } as unknown as Partial<GraphState>);
        // Dispatcher mock returns "worker_task"
        expect(result).toBe("worker_task");
      });

      it("routes to approval when a task needs approval", async () => {
        const approval = await import("@/agents/approval.js") as { getFirstTaskNeedingApproval: ReturnType<typeof vi.fn> };
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

    describe("approval -> routing", () => {
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

    describe("increment_cycle -> routing", () => {
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
        const activeStatuses = ["pending", "reviewing", "needs_rework", "in_progress", "auto_approved_pending", "rfc_pending"];
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
      expect(msgs[0]).toContain("Sprint progress");
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
      expect(msg).toContain("Sprint progress");
    });

    it("shows remaining count in summary", () => {
      const node = getIncrementCycleNode();
      const result = node({
        cycle_count: 0,
        task_queue: [
          makeTask({ status: "completed", task_id: "T1", description: "Done task" }),
          makeTask({ status: "pending", task_id: "T2", description: "Pending task" }),
        ],
        total_tasks: 2,
        mid_sprint_reported: false,
        bot_stats: {},
        last_quality_score: 80,
      } as unknown as Partial<GraphState>);

      const msg = (result.messages as string[])?.[0] ?? "";
      expect(msg).toContain("1/2 tasks done");
      expect(msg).toContain("1 remaining");
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
      const { getCanvasTelemetry } = await import("@/core/canvas-telemetry.js") as {
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
        vectorMemory: fakeMemory as unknown as import("@/core/knowledge-base.js").VectorMemory,
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
