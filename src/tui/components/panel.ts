/**
 * Reusable Panel component — bordered box for slash command output.
 * All interactive views (/settings, /sessions, /model, /help, /agents, /cost)
 * render inside a Panel for visual consistency.
 */
import { visibleWidth } from "../utils/text-width.js";
import { truncate } from "../utils/truncate.js";
import { ctp } from "../themes/default.js";

export interface PanelOptions {
  title: string;
  width?: number;
  footer?: string;
  borderColor?: (s: string) => string;
  titleColor?: (s: string) => string;
}

/**
 * Render content lines inside a bordered panel.
 * Returns array of ANSI-styled terminal lines.
 */
export function renderPanel(options: PanelOptions, contentLines: string[]): string[] {
  const border = options.borderColor ?? ctp.surface1;
  const titleFn = options.titleColor ?? ctp.mauve;
  const w = Math.min(options.width ?? 60, 70);
  const output: string[] = [];

  // Top border with title
  const titleStr = ` ${options.title} `;
  const titleWidth = visibleWidth(titleStr);
  const rightBorder = Math.max(0, w - titleWidth - 3);
  output.push("  " + border("┌─") + titleFn(titleStr) + border("─".repeat(rightBorder) + "┐"));

  // Empty line after title
  output.push("  " + border("│") + " ".repeat(w - 2) + border("│"));

  // Content lines — truncate to fit within borders
  const innerWidth = w - 4; // border + padding on each side
  for (const line of contentLines) {
    const lineWidth = visibleWidth(line);
    let fitted: string;
    if (lineWidth <= innerWidth) {
      fitted = line + " ".repeat(innerWidth - lineWidth);
    } else {
      fitted = truncate(line, innerWidth);
      const fittedWidth = visibleWidth(fitted);
      fitted += " ".repeat(Math.max(0, innerWidth - fittedWidth));
    }
    output.push("  " + border("│") + " " + fitted + " " + border("│"));
  }

  // Empty line before footer
  output.push("  " + border("│") + " ".repeat(w - 2) + border("│"));

  // Footer with keyboard hints
  if (options.footer) {
    const footerStyled = ctp.overlay0(options.footer);
    const footerWidth = visibleWidth(options.footer);
    const footerPad = Math.max(0, w - 3 - footerWidth);
    output.push("  " + border("│") + " " + footerStyled + " ".repeat(footerPad) + border("│"));
  }

  // Bottom border
  output.push("  " + border("└" + "─".repeat(w - 2) + "┘"));

  return output;
}

/**
 * Render a section header inside a panel.
 */
export function panelSection(title: string, width = 50): string[] {
  return [
    ctp.text(title),
    ctp.surface1("─".repeat(Math.min(width, 50))),
  ];
}

/**
 * Render a selectable row with hover/selected states.
 */
export function panelRow(
  label: string,
  value: string,
  opts: { selected?: boolean; hovered?: boolean; hint?: string } = {},
): string {
  const prefix = opts.selected ? ctp.mauve("❯ ") : "  ";
  const nameColor = (opts.selected || opts.hovered) ? ctp.text : ctp.subtext1;
  const valueColor = (opts.selected || opts.hovered) ? ctp.subtext1 : ctp.overlay1;

  const name = nameColor(label.padEnd(16));
  const val = valueColor(value.padEnd(20));
  const hint = opts.hint ? ctp.overlay0(opts.hint) : "";

  return prefix + name + val + hint;
}
