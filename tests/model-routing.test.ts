import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/core/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), plain: vi.fn(), success: vi.fn() },
}));

// Mock global config to return no model (so tier defaults take effect)
vi.mock("../src/core/global-config.js", () => ({
  readGlobalConfig: vi.fn().mockReturnValue(null),
  buildDefaultGlobalConfig: vi.fn().mockReturnValue({
    version: 1,
    dashboardPort: 9001,
    debugMode: false,
  }),
}));

import {
  resolveModelForAgent,
  setAgentModel,
  resetAgentModels,
  setActiveProviderFamily,
  clearModelConfigCache,
  setConfigAgentModels,
} from "../src/core/model-config.js";
import { resetTokenOptStats, getTokenOptStats } from "../src/token-opt/stats.js";

describe("Model Routing — Tier Defaults", () => {
  beforeEach(() => {
    resetAgentModels();
    setConfigAgentModels({});
    resetTokenOptStats();
    setActiveProviderFamily("generic");
  });

  it("tester resolves to haiku when provider family is anthropic", () => {
    setActiveProviderFamily("anthropic");
    const model = resolveModelForAgent("tester");
    expect(model).toBe("claude-haiku-4-5");
  });

  it("tester resolves to gpt-4o-mini when provider family is openai", () => {
    setActiveProviderFamily("openai");
    const model = resolveModelForAgent("tester");
    expect(model).toBe("gpt-4o-mini");
  });

  it("standup resolves to haiku when provider family is anthropic", () => {
    setActiveProviderFamily("anthropic");
    const model = resolveModelForAgent("standup");
    expect(model).toBe("claude-haiku-4-5");
  });

  it("briefing resolves to mini tier", () => {
    setActiveProviderFamily("anthropic");
    const model = resolveModelForAgent("briefing");
    expect(model).toBe("claude-haiku-4-5");
  });

  it("coordinator does NOT get tier default (primary tier)", () => {
    setActiveProviderFamily("anthropic");
    const model = resolveModelForAgent("coordinator");
    expect(model).toBe("");
  });

  it("planner does NOT get tier default", () => {
    setActiveProviderFamily("anthropic");
    const model = resolveModelForAgent("planner");
    expect(model).toBe("");
  });

  it("user override wins over tier default", () => {
    setActiveProviderFamily("anthropic");
    setAgentModel("tester", "claude-sonnet-4-6");
    const model = resolveModelForAgent("tester");
    expect(model).toBe("claude-sonnet-4-6");
  });

  it("unknown role defaults to empty string (no tier)", () => {
    setActiveProviderFamily("anthropic");
    const model = resolveModelForAgent("some-custom-role");
    expect(model).toBe("");
  });

  it("generic provider family returns empty for tier roles", () => {
    setActiveProviderFamily("generic");
    const model = resolveModelForAgent("tester");
    expect(model).toBe("");
  });

  it("records tier downgrade in stats", () => {
    setActiveProviderFamily("anthropic");
    resolveModelForAgent("tester");
    const stats = getTokenOptStats();
    expect(stats.tierDowngrades).toBe(1);
    expect(stats.tierDowngradeDetails[0]).toEqual({
      role: "tester",
      model: "claude-haiku-4-5",
    });
  });

  it("does not record tier downgrade for primary agents", () => {
    setActiveProviderFamily("anthropic");
    resolveModelForAgent("coordinator");
    const stats = getTokenOptStats();
    expect(stats.tierDowngrades).toBe(0);
  });

  it("config agent model overrides tier default", () => {
    setActiveProviderFamily("anthropic");
    setConfigAgentModels({ tester: "claude-sonnet-4-6" });
    const model = resolveModelForAgent("tester");
    expect(model).toBe("claude-sonnet-4-6");
  });
});
