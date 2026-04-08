import { describe, it, expect } from "bun:test";
import {
  initializeGameState,
  initializeTeamState,
  type GameState,
} from "@/core/state.js";
import { buildTeamFromTemplate } from "@/core/team-templates.js";

describe("state", () => {
  it("initializeGameState returns valid state", () => {
    const state = initializeGameState(1, []);
    expect(state.cycle_count).toBe(0);
    expect(state.generation_id).toBe(1);
    expect(state.task_queue).toEqual([]);
    expect(state.team).toEqual([]);
    expect(state.bot_stats).toEqual({});
    expect(state.messages.length).toBeGreaterThan(0);
  });

  it("initializeTeamState sets team and bot_stats", () => {
    const team = [
      { id: "bot_0", name: "Dev", role_id: "software_engineer", traits: {} },
    ];
    const extra = initializeTeamState(team, "Build a game");
    expect(extra.team).toEqual(team);
    expect(extra.user_goal).toBe("Build a game");
    expect(extra.bot_stats).toHaveProperty("bot_0");
    expect((extra.bot_stats as Record<string, unknown>)["bot_0"]).toMatchObject({
      tasks_completed: 0,
      tasks_failed: 0,
    });
  });
});

describe("team-templates", () => {
  it("buildTeamFromTemplate returns bots for game_dev", () => {
    const team = buildTeamFromTemplate("game_dev");
    expect(team.length).toBe(5);
    expect(team[0]).toMatchObject({
      id: "bot_0",
      role_id: "software_engineer",
    });
    expect(team.some((b) => b.role_id === "artist")).toBe(true);
    expect(team.some((b) => b.role_id === "sfx_designer")).toBe(true);
  });

  it("buildTeamFromTemplate returns empty for unknown template", () => {
    const team = buildTeamFromTemplate("unknown");
    expect(team).toEqual([]);
  });
});
