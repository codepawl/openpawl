/**
 * Tool permission prompt formatting for the TUI approval flow.
 */

import { ICONS } from "../tui/constants/icons.js";
import { defaultTheme } from "../tui/themes/default.js";
import { bold } from "../tui/core/ansi.js";

/** Map of tool names to their primary argument key (the one to display prominently). */
const TOOL_PRIMARY_ARG: Record<string, string> = {
  shell_exec: "command",
  file_read: "path",
  file_write: "path",
  file_edit: "file_path",
  file_list: "path",
  git_ops: "command",
  execute_code: "code",
  web_search: "query",
  web_fetch: "url",
};

/** Risk indicator icon + color for each risk level. */
function riskIndicator(riskLevel: string): { icon: string; color: (s: string) => string } {
  switch (riskLevel) {
    case "dangerous":
    case "destructive":
      return { icon: ICONS.warning, color: defaultTheme.warning };
    case "moderate":
      return { icon: "\u270e", color: defaultTheme.info };
    default:
      return { icon: ICONS.success, color: defaultTheme.success };
  }
}

/** Build the styled action buttons string. */
function permissionButtons(): string {
  const y = defaultTheme.success(`[${bold("Y")}]es`);
  const n = defaultTheme.error(`[${bold("N")}]o`);
  const a = defaultTheme.warning(`[${bold("!")}]Always`);
  return `${y}    ${n}    ${a}`;
}

/** Format the tool permission prompt as flush-left text with risk icon. */
export function formatToolPermissionPrompt(toolName: string, input: unknown, riskLevel: string): string {
  const risk = riskIndicator(riskLevel);
  const inputObj = typeof input === "object" && input !== null
    ? input as Record<string, unknown> : null;

  const primaryKey = TOOL_PRIMARY_ARG[toolName];
  const primaryValue = primaryKey && inputObj ? String(inputObj[primaryKey] ?? "") : "";

  const lines: string[] = [];
  lines.push(`${risk.color(risk.icon)} ${bold(toolName)}`);

  if (primaryValue) {
    const display = primaryValue.length > 120
      ? primaryValue.slice(0, 117) + "..."
      : primaryValue;
    lines.push(`  ${defaultTheme.secondary(display)}`);
  }

  const HIDDEN_ARGS = new Set([primaryKey, "timeout", "signal", "cwd", "env"].filter(Boolean));
  if (inputObj) {
    const extras = Object.entries(inputObj)
      .filter(([k]) => !HIDDEN_ARGS.has(k))
      .filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (extras.length > 0) {
      const extraStr = extras.map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const short = val.length > 60 ? val.slice(0, 57) + "..." : val;
        return `${k}: ${short}`;
      }).join("  ");
      lines.push(`  ${defaultTheme.dim(extraStr)}`);
    }
  } else if (!primaryValue && input !== undefined) {
    lines.push(`  ${defaultTheme.dim(String(input).slice(0, 120))}`);
  }

  lines.push(`  ${permissionButtons()}`);
  return lines.join("\n");
}

/** Format a resolved permission prompt (after user presses Y/N/!). */
export function formatToolPermissionResolved(toolName: string, riskLevel: string, result: string, resultColor: (s: string) => string): string {
  const risk = riskIndicator(riskLevel);
  return `${risk.color(risk.icon)} ${bold(toolName)}  ${resultColor(result)}`;
}
