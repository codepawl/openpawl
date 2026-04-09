import { describe, test, expect } from "bun:test";
import { agentBadge, statusBadge, modeBadge } from "../../../src/tui/primitives/badge.js";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("badge", () => {
  test("agentBadge includes agent name", () => {
    const badge = strip(agentBadge("Coder"));
    expect(badge).toContain("\u25c6");
    expect(badge).toContain("Coder");
  });

  test("statusBadge success uses check mark", () => {
    const badge = strip(statusBadge("success"));
    expect(badge).toContain("\u2713");
  });

  test("statusBadge error uses cross", () => {
    const badge = strip(statusBadge("error"));
    expect(badge).toContain("\u2717");
  });

  test("modeBadge includes icon and name", () => {
    const badge = strip(modeBadge("auto-accept", "AUTO", (s) => s));
    expect(badge).toContain("\u26a1");
    expect(badge).toContain("AUTO");
  });
});
