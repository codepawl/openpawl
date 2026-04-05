/**
 * Individual status bar section renderers.
 * Each section renders independently, composed by the status bar.
 */

import { defaultTheme } from "../themes/default.js";
import type { StatusBarState } from "./status-data.js";
import { formatCost, formatTokens } from "./status-data.js";

export interface StatusSection {
  content: string;
  minWidth: number;
  priority: number;
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
let spinnerFrame = 0;

export function advanceSpinner(): void {
  spinnerFrame++;
}

export function renderModelSection(state: StatusBarState): StatusSection {
  const content = state.modelDisplay || state.model || "no model";
  return {
    content: defaultTheme.bold(content),
    minWidth: Math.min(content.length, 20),
    priority: 1,
  };
}

export function renderCostSection(state: StatusBarState): StatusSection {
  const cost = state.totalCostUSD;
  const display = formatCost(cost);
  const colorFn = cost > 5 ? defaultTheme.error : cost > 1 ? defaultTheme.warning : defaultTheme.success;
  return {
    content: colorFn(display),
    minWidth: 6,
    priority: 2,
  };
}

export function renderTokenSection(state: StatusBarState): StatusSection {
  const total = state.totalInputTokens + state.totalOutputTokens;
  const display = `${formatTokens(total)} tokens`;
  return {
    content: defaultTheme.dim(display),
    minWidth: 8,
    priority: 4,
  };
}

export function renderAgentSection(state: StatusBarState): StatusSection {
  if (state.activeAgents.length === 0) {
    return { content: "", minWidth: 0, priority: 3 };
  }

  const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
  const agents = state.activeAgents.map((a) => {
    const colorFn = defaultTheme.agentColors[0] ?? defaultTheme.primary;
    return `${frame} ${colorFn(a.agentName)}`;
  });

  const content = agents.join("  ");
  return {
    content,
    minWidth: 8 * state.activeAgents.length,
    priority: 3,
  };
}

export function renderSessionSection(state: StatusBarState): StatusSection {
  let content: string;
  switch (state.sessionStatus) {
    case "active":
      content = defaultTheme.success("●") + " session";
      break;
    case "idle":
      content = defaultTheme.dim("○") + " idle";
      break;
    case "streaming": {
      const elapsed = Math.floor(state.streamingDuration / 1000);
      content = `${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]} streaming ${elapsed}s`;
      break;
    }
    case "recovering":
      content = defaultTheme.warning("⚠") + " recovering";
      break;
  }
  return { content, minWidth: 8, priority: 5 };
}

export function renderHintsSection(state: StatusBarState): StatusSection {
  if (!state.showHints || state.contextualHints.length === 0) {
    return { content: "", minWidth: 0, priority: 6 };
  }

  const hints = state.contextualHints
    .filter((h) => h.available)
    .map((h) => `${defaultTheme.bold(h.key)} ${defaultTheme.dim(h.action)}`)
    .join("  ");

  return { content: hints, minWidth: 20, priority: 6 };
}

/**
 * Compose all sections into a single status bar line.
 * Drops lowest-priority sections if terminal too narrow.
 */
export function composeStatusBar(state: StatusBarState, terminalWidth: number): string {
  const sections = [
    renderModelSection(state),
    renderCostSection(state),
    renderAgentSection(state),
    renderTokenSection(state),
    renderSessionSection(state),
    renderHintsSection(state),
  ].filter((s) => s.content.length > 0);

  const separator = "  │  ";
  const sepWidth = 5;

  // Sort by priority (lower = keep first)
  sections.sort((a, b) => a.priority - b.priority);

  // Drop lowest-priority sections until it fits
  const included: StatusSection[] = [];
  let totalWidth = 0;

  for (const section of sections) {
    const needed = totalWidth > 0 ? section.minWidth + sepWidth : section.minWidth;
    if (totalWidth + needed <= terminalWidth) {
      included.push(section);
      totalWidth += needed;
    }
  }

  const line = included.map((s) => s.content).join(defaultTheme.dim(separator));
  return ` ${line}`;
}
