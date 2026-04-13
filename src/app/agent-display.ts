/**
 * Agent display helpers — color mapping, display names, token formatting.
 */

import { ICONS } from "../tui/constants/icons.js";
import { formatTokens } from "../utils/formatters.js";
import { defaultTheme } from "../tui/themes/default.js";

export function formatTokenPair(input: number, output: number): string {
  if (input === 0 && output === 0) return "";
  return `${defaultTheme.info(`${formatTokens(input)}${ICONS.arrowUp}`)} ${defaultTheme.warning(`${formatTokens(output)}${ICONS.arrowDown}`)}`;
}

const AGENT_COLOR_MAP: Record<string, number> = {
  coder: 0,
  reviewer: 1,
  planner: 4,
  tester: 3,
  debugger: 2,
  researcher: 5,
  assistant: 7,
};

export function getAgentColorFn(agentId: string): (s: string) => string {
  const colors = defaultTheme.agentColors;
  const idx = AGENT_COLOR_MAP[agentId];
  if (idx !== undefined) return colors[idx % colors.length]!;
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length]!;
}

export function agentDisplayName(agentId: string): string {
  const names: Record<string, string> = {
    coder: "Coder",
    reviewer: "Reviewer",
    planner: "Planner",
    tester: "Tester",
    debugger: "Debugger",
    researcher: "Researcher",
    assistant: "Assistant",
    system: "System",
  };
  return names[agentId] ?? agentId;
}
