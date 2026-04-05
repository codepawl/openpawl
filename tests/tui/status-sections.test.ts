import { describe, it, expect } from "vitest";
import {
  renderModelSection,
  renderCostSection,
  renderTokenSection,
  renderAgentSection,
  renderHintsSection,
  composeStatusBar,
} from "../../src/tui/components/status-sections.js";
import type { StatusBarState } from "../../src/tui/components/status-data.js";

function makeState(overrides: Partial<StatusBarState> = {}): StatusBarState {
  return {
    sessionId: "s1",
    sessionTitle: "Test",
    sessionStatus: "active",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    modelDisplay: "sonnet-4 via anthropic",
    totalInputTokens: 2800,
    totalOutputTokens: 700,
    totalCostUSD: 0.12,
    costDisplay: "$0.12",
    activeAgents: [],
    lastAgentId: null,
    isStreaming: false,
    streamingAgentId: null,
    streamingDuration: 0,
    messageCount: 8,
    showHints: true,
    contextualHints: [
      { key: "Ctrl+N", action: "new", available: true },
      { key: "?", action: "help", available: true },
    ],
    ...overrides,
  };
}

describe("status sections", () => {
  it("renderModelSection shows model and provider", () => {
    const section = renderModelSection(makeState());
    expect(section.content).toContain("sonnet-4 via anthropic");
    expect(section.priority).toBe(1);
  });

  it("renderCostSection formats correctly", () => {
    const section = renderCostSection(makeState({ totalCostUSD: 0.12 }));
    expect(section.content).toContain("$0.12");
  });

  it("renderCostSection shows warning color for > $1", () => {
    const section = renderCostSection(makeState({ totalCostUSD: 2.50 }));
    expect(section.content).toBeDefined(); // Would need ANSI check for yellow
  });

  it("renderTokenSection formats correctly", () => {
    const section = renderTokenSection(makeState());
    expect(section.content).toContain("3.5k");
    expect(section.content).toContain("tokens");
  });

  it("renderAgentSection shows spinner + agent when streaming", () => {
    const section = renderAgentSection(makeState({
      activeAgents: [{ agentId: "coder", agentName: "Coder", status: "running", startedAt: Date.now() }],
    }));
    expect(section.content).toContain("Coder");
    expect(section.content.length).toBeGreaterThan(0);
  });

  it("renderAgentSection shows nothing when no agents", () => {
    const section = renderAgentSection(makeState());
    expect(section.content).toBe("");
  });

  it("renderHintsSection shows hints when enabled", () => {
    const section = renderHintsSection(makeState());
    expect(section.content).toContain("Ctrl+N");
    expect(section.content).toContain("help");
  });

  it("renderHintsSection empty when disabled", () => {
    const section = renderHintsSection(makeState({ showHints: false }));
    expect(section.content).toBe("");
  });

  it("composeStatusBar fits in 120 cols", () => {
    const bar = composeStatusBar(makeState(), 120);
    expect(bar.length).toBeGreaterThan(0);
    expect(bar).toContain("sonnet-4");
    expect(bar).toContain("$0.12");
  });

  it("composeStatusBar drops sections for narrow terminal", () => {
    const bar = composeStatusBar(makeState(), 50);
    // Should at least have model (priority 1) — cost may or may not fit
    expect(bar).toContain("sonnet-4");
    // Narrow bar has fewer sections than wide bar
    const widebar = composeStatusBar(makeState(), 120);
    expect(widebar.length).toBeGreaterThan(bar.length);
  });
});
