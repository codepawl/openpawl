/**
 * Execution tests for src/core/simulation.ts — run() and stream()
 *
 * All vi.hoisted() and vi.mock() calls are inline (cannot be shared).
 * Only data helpers (makeTeam) come from shared utils.
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

import { createTeamOrchestration } from "@/core/simulation.js";
import { makeTeam } from "./simulation-test-utils.js";

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("simulation.ts — Execution (run & stream)", () => {
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
});
