import { describe, it, expect, vi } from "vitest";
import { StatusDataStore, formatCost, formatTokens } from "../../src/tui/components/status-data.js";

describe("StatusDataStore", () => {
  it("initial state has null sessionId and zero costs", () => {
    const store = new StatusDataStore();
    const state = store.getState();
    expect(state.sessionId).toBeNull();
    expect(state.totalCostUSD).toBe(0);
    expect(state.costDisplay).toBe("$0.00");
  });

  it("handleSessionCreated sets sessionId, title, model, provider", () => {
    const store = new StatusDataStore();
    store.handleSessionCreated("s1", "Fix auth", "claude-sonnet-4-6", "anthropic");
    const state = store.getState();
    expect(state.sessionId).toBe("s1");
    expect(state.sessionTitle).toBe("Fix auth");
    expect(state.model).toBe("claude-sonnet-4-6");
    expect(state.provider).toBe("anthropic");
    expect(state.modelDisplay).toContain("anthropic");
  });

  it("handleCostUpdate updates totals and costDisplay", () => {
    const store = new StatusDataStore();
    store.handleCostUpdate(1000, 500, 0.12);
    const state = store.getState();
    expect(state.totalInputTokens).toBe(1000);
    expect(state.totalOutputTokens).toBe(500);
    expect(state.totalCostUSD).toBe(0.12);
    expect(state.costDisplay).toBe("$0.12");
  });

  it("handleAgentStart adds agent to activeAgents", () => {
    const store = new StatusDataStore();
    store.handleAgentStart("coder", "Coder");
    expect(store.getState().activeAgents).toHaveLength(1);
    expect(store.getState().activeAgents[0]!.agentId).toBe("coder");
  });

  it("handleAgentDone removes agent from activeAgents", () => {
    const store = new StatusDataStore();
    store.handleAgentStart("coder", "Coder");
    store.handleAgentDone("coder");
    expect(store.getState().activeAgents).toHaveLength(0);
  });

  it("handleStreamingStart sets isStreaming true", () => {
    const store = new StatusDataStore();
    store.handleStreamingStart();
    expect(store.getState().isStreaming).toBe(true);
    expect(store.getState().sessionStatus).toBe("streaming");
    store.stopTimers();
  });

  it("handleStreamingDone sets isStreaming false", () => {
    const store = new StatusDataStore();
    store.handleStreamingStart();
    store.handleStreamingDone();
    expect(store.getState().isStreaming).toBe(false);
    expect(store.getState().sessionStatus).toBe("active");
  });

  it("handleSessionIdle sets sessionStatus to idle", () => {
    const store = new StatusDataStore();
    store.handleSessionIdle();
    expect(store.getState().sessionStatus).toBe("idle");
  });

  it("handleModelSwitch updates model and provider", () => {
    const store = new StatusDataStore();
    store.handleModelSwitch("gpt-4o", "openai");
    expect(store.getState().model).toBe("gpt-4o");
    expect(store.getState().provider).toBe("openai");
  });

  it("handleMessageCountUpdate updates messageCount", () => {
    const store = new StatusDataStore();
    store.handleMessageCountUpdate(15);
    expect(store.getState().messageCount).toBe(15);
  });

  it("onChange callback fires on state change", () => {
    const store = new StatusDataStore();
    const fn = vi.fn();
    store.onChange(fn);
    store.handleCostUpdate(100, 50, 0.01);
    expect(fn).toHaveBeenCalled();
  });

  it("updateHints returns IDLE hints when not streaming", () => {
    const store = new StatusDataStore();
    store.updateHints();
    const hints = store.getState().contextualHints;
    expect(hints.some((h) => h.key === "Ctrl+N")).toBe(true);
  });

  it("updateHints returns STREAMING hints when agent active", () => {
    const store = new StatusDataStore();
    store.handleStreamingStart();
    const hints = store.getState().contextualHints;
    expect(hints.some((h) => h.key === "Esc")).toBe(true);
    expect(hints.some((h) => h.key === "Ctrl+N")).toBe(false);
    store.stopTimers();
  });
});

describe("formatCost", () => {
  it("formats $0.12 correctly", () => { expect(formatCost(0.12)).toBe("$0.12"); });
  it("formats $1.50 correctly", () => { expect(formatCost(1.50)).toBe("$1.50"); });
  it("formats $12.34 correctly", () => { expect(formatCost(12.34)).toBe("$12.3"); });
  it("formats $142 correctly", () => { expect(formatCost(142)).toBe("$142"); });
});

describe("formatTokens", () => {
  it("formats 847 as '847'", () => { expect(formatTokens(847)).toBe("847"); });
  it("formats 3500 as '3.5k'", () => { expect(formatTokens(3500)).toBe("3.5k"); });
  it("formats 45000 as '45k'", () => { expect(formatTokens(45000)).toBe("45k"); });
  it("formats 1200000 as '1.2M'", () => { expect(formatTokens(1200000)).toBe("1.2M"); });
});
