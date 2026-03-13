import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoordinatorAgent } from "../src/agents/coordinator.js";

const mockAdapter = {
  executeTask: vi.fn(),
  executeStream: vi.fn(),
};

describe("CoordinatorAgent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates coordinator with custom adapter", () => {
    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });
    expect(agent).toBeDefined();
  });

  it("coordinateNode without user_goal returns early", async () => {
    const state: any = {
      team: [],
      task_queue: [],
      user_goal: null,
      bot_stats: {},
      messages: [],
    };

    const agent = new CoordinatorAgent({ llmAdapter: mockAdapter as any });
    const result = await agent.coordinateNode(state);

    expect(mockAdapter.executeTask).not.toHaveBeenCalled();
    expect(result.last_action).toBe("Coordinator processed");
    expect(result.__node__).toBe("coordinator");
  });
});
