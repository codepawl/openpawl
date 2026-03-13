import { describe, it, expect } from "vitest";
import { createTeamOrchestration } from "../src/core/simulation.js";

describe("simulation", () => {
  it("getInitialState merges initialTasks and team correctly", () => {
    const team: any[] = [
      { id: "bot_0", name: "A", role_id: "engineer", traits: {}, worker_url: null },
    ];
    const orch = createTeamOrchestration({ team, workerUrls: {} });

    const state = orch.getInitialState({
      userGoal: "Build app",
      initialTasks: [
        { assigned_to: "bot_0", description: "Task 1" },
      ],
    });

    expect(state.user_goal).toBe("Build app");
    expect(state.team).toHaveLength(1);
    const q = state.task_queue as Array<any>;
    expect(q).toHaveLength(1);
    expect(q[0].description).toBe("Task 1");
    expect(q[0].assigned_to).toBe("bot_0");
  });

  it("getInitialState with empty tasks", () => {
    const team: any[] = [
      { id: "bot_0", name: "Dev", role_id: "engineer", traits: {}, worker_url: null },
    ];
    const orch = createTeamOrchestration({ team, workerUrls: {} });

    const state = orch.getInitialState({
      userGoal: "Build app",
    });

    expect(state.user_goal).toBe("Build app");
    const q = state.task_queue as Array<any>;
    expect(q).toHaveLength(0);
  });
});
