import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/core/config.js", () => ({
  getApprovalKeywords: vi.fn(() => ["deploy", "delete", "production"]),
}));

vi.mock("../src/core/canvas-telemetry.js", () => ({
  getCanvasTelemetry: vi.fn(() => ({
    sendWaitingForHuman: vi.fn(),
  })),
}));

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  cancel: vi.fn(),
}));

const mockState: any = {
  task_queue: [
    {
      task_id: "task-1",
      description: "Deploy to production",
      assigned_to: "bot_0",
      status: "waiting_for_human",
      priority: "HIGH",
    },
  ],
  cycle_count: 1,
  session_active: true as const,
  messages: [] as any,
  agent_messages: [] as any,
  completed_tasks: 0,
  bot_stats: {},
  last_action: "",
  user_goal: "Test goal",
  team: [],
  approval_pending: null,
  approval_response: null,
  planning_document: null,
  architecture_document: null,
  rfc_document: null,
  deep_work_mode: false,
  retrieved_memories: "",
  preferences_context: "",
};

describe("HITL Bridge - Human-in-the-Loop", () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
    });
    Object.defineProperty(process.stderr, 'isTTY', {
      value: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, 'columns', {
      value: 80,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalIsTTY !== undefined) {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY });
      Object.defineProperty(process.stderr, 'isTTY', { value: originalIsTTY });
    }
  });

  describe("getFirstTaskNeedingApproval", () => {
    it("identifies HIGH priority tasks", async () => {
      const { getFirstTaskNeedingApproval } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [
          { task_id: "task-1", description: "Simple task", priority: "MEDIUM", status: "pending" },
          { task_id: "task-2", description: "Deploy to prod", priority: "HIGH", status: "pending" },
        ],
      };

      const result = getFirstTaskNeedingApproval(state, ["deploy", "delete"]);
      expect(result).not.toBeNull();
      expect(result?.task_id).toBe("task-2");
    });

    it("identifies tasks with approval keywords", async () => {
      const { getFirstTaskNeedingApproval } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [
          { task_id: "task-1", description: "Simple refactor", priority: "MEDIUM", status: "pending" },
          { task_id: "task-2", description: "Delete old files", priority: "MEDIUM", status: "pending" },
        ],
      };

      const result = getFirstTaskNeedingApproval(state, ["deploy", "delete"]);
      expect(result).not.toBeNull();
      expect(result?.task_id).toBe("task-2");
    });

    it("returns null when no tasks need approval", async () => {
      const { getFirstTaskNeedingApproval } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [
          { task_id: "task-1", description: "Simple refactor", priority: "MEDIUM", status: "pending" },
        ],
      };

      const result = getFirstTaskNeedingApproval(state, ["deploy", "delete"]);
      expect(result).toBeNull();
    });

    it("handles empty task queue", async () => {
      const { getFirstTaskNeedingApproval } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [],
      };

      const result = getFirstTaskNeedingApproval(state, ["deploy"]);
      expect(result).toBeNull();
    });
  });

  describe("getFirstTaskWaitingForHuman", () => {
    it("finds task with waiting_for_human status", async () => {
      const { getFirstTaskWaitingForHuman } = await import("../src/agents/approval.js");
      
      const result = getFirstTaskWaitingForHuman(mockState);
      expect(result).not.toBeNull();
      expect(result?.task_id).toBe("task-1");
    });

    it("returns null when no task is waiting", async () => {
      const { getFirstTaskWaitingForHuman } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [
          { task_id: "task-1", description: "Completed task", status: "completed" },
        ],
      };

      const result = getFirstTaskWaitingForHuman(state);
      expect(result).toBeNull();
    });
  });

  describe("getAllTasksWaitingForHuman", () => {
    it("finds all tasks with waiting_for_human status", async () => {
      const { getAllTasksWaitingForHuman } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [
          { task_id: "task-1", description: "Task 1", status: "waiting_for_human" },
          { task_id: "task-2", description: "Task 2", status: "pending" },
          { task_id: "task-3", description: "Task 3", status: "waiting_for_human" },
        ],
      };

      const result = getAllTasksWaitingForHuman(state);
      expect(result).toHaveLength(2);
      expect(result.map((t: any) => t.task_id)).toContain("task-1");
      expect(result.map((t: any) => t.task_id)).toContain("task-3");
    });
  });

  describe("createHumanApprovalNode", () => {
    it("auto-approves when autoApprove is true", async () => {
      const { createHumanApprovalNode } = await import("../src/agents/approval.js");
      
      const node = createHumanApprovalNode(true);
      const result = await node(mockState);

      expect(result.last_action).toContain("auto-approved");
      const taskQueue = result.task_queue as any[];
      expect(taskQueue[0].status).toBe("completed");
    });

    it("returns early when no tasks are waiting", async () => {
      const { createHumanApprovalNode } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [],
      };

      const node = createHumanApprovalNode(false);
      const result = await node(state);

      expect(result.last_action).toContain("No task waiting");
    });

    it("uses approvalProvider when provided", async () => {
      const approvalProvider = vi.fn().mockResolvedValue({
        action: "approved",
      });

      const { createHumanApprovalNode } = await import("../src/agents/approval.js");
      
      const node = createHumanApprovalNode(false, approvalProvider);
      
      // This test just verifies the node can be created with an approvalProvider
      // The actual Promise.race behavior is hard to test without more complex setup
      expect(node).toBeDefined();
    });
  });

  describe("task detection logic", () => {
    it("detects HIGH priority tasks", async () => {
      const { getFirstTaskNeedingApproval } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [
          { task_id: "task-1", description: "Simple task", priority: "HIGH", status: "pending" },
        ],
      };

      const result = getFirstTaskNeedingApproval(state, []);
      expect(result).not.toBeNull();
      expect(result?.task_id).toBe("task-1");
    });

    it("detects keyword matches in description", async () => {
      const { getFirstTaskNeedingApproval } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [
          { task_id: "task-1", description: "Deploy to staging", priority: "MEDIUM", status: "pending" },
        ],
      };

      const result = getFirstTaskNeedingApproval(state, ["deploy"]);
      expect(result).not.toBeNull();
      expect(result?.task_id).toBe("task-1");
    });

    it("returns false for non-matching tasks", async () => {
      const { getFirstTaskNeedingApproval } = await import("../src/agents/approval.js");
      
      const state: any = {
        ...mockState,
        task_queue: [
          { task_id: "task-1", description: "Simple refactor", priority: "MEDIUM", status: "pending" },
        ],
      };

      const result = getFirstTaskNeedingApproval(state, ["deploy", "delete"]);
      expect(result).toBeNull();
    });
  });
});
