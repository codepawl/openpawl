/**
 * Welcome banner content builder.
 */

import { VERSION } from "../version.js";
import { PRODUCT_TAGLINE_LONG } from "../meta/product.js";
import { defaultTheme } from "../tui/themes/default.js";
import { bold } from "../tui/core/ansi.js";
import { visibleWidth } from "../tui/utils/text-width.js";

/** Build the welcome banner content, freshly computed for current terminal width. */
export function buildWelcomeContent(): string {
  const termWidth = process.stdout.columns ?? 80;
  const lines: string[] = [];

  const title = `OpenPawl v${VERSION}`;
  const titlePad = Math.max(0, Math.floor((termWidth - title.length) / 2));
  lines.push("");
  lines.push(" ".repeat(titlePad) + bold(defaultTheme.primary(title)));

  const tagline = PRODUCT_TAGLINE_LONG;
  const tagPad = Math.max(0, Math.floor((termWidth - tagline.length) / 2));
  lines.push(defaultTheme.dim(" ".repeat(tagPad) + tagline));
  lines.push("");

  const cmdPad = 12;
  const allItems: ([string, string] | null)[] = [
    [defaultTheme.info("/help"), "Show commands"],
    [defaultTheme.info("/settings"), "Configure provider"],
    [defaultTheme.info("/agents"), "List agents"],
    [defaultTheme.warning("!command"), "Run shell command"],
    [defaultTheme.info("@file"), "Reference a file"],
    null,
    [defaultTheme.info("@coder"), "Coder"],
    [defaultTheme.info("@reviewer"), "Reviewer"],
    [defaultTheme.info("@planner"), "Planner"],
    [defaultTheme.info("@tester"), "Tester"],
    [defaultTheme.info("@debugger"), "Debugger"],
  ];

  const tableLines: string[] = [];
  for (const item of allItems) {
    if (!item) { tableLines.push(""); continue; }
    const [cmd, desc] = item;
    const cmdVis = visibleWidth(cmd);
    const gap = " ".repeat(Math.max(2, cmdPad - cmdVis));
    tableLines.push(`${cmd}${gap}${defaultTheme.dim(desc)}`);
  }

  const maxTableWidth = tableLines.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
  const tablePad = " ".repeat(Math.max(0, Math.floor((termWidth - maxTableWidth) / 2)));
  for (const row of tableLines) {
    lines.push(tablePad + row);
  }

  lines.push("");
  const tip = "Type a prompt to get started. Shift+Tab to switch modes.";
  const tipPad = Math.max(0, Math.floor((termWidth - tip.length) / 2));
  lines.push(" ".repeat(tipPad) + defaultTheme.dim(tip));
  lines.push("");

  return lines.join("\n");
}
