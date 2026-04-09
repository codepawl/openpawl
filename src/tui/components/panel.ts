/**
 * Reusable Panel component — bordered box with title/footer.
 * All interactive views, slash commands, and overlays render through this.
 */
import { visibleWidth } from "../utils/text-width.js";
import { truncate } from "../utils/truncate.js";
import { ctp } from "../themes/default.js";
import { separator } from "../primitives/separator.js";
import { labelValue } from "../primitives/columns.js";

// ─── Border character sets ──────────────────────────────────────────────────

const BORDERS = {
  single:  { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  double:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
} as const;

// ─── Options ────────────────────────────────────────────────────────────────

export interface PanelOptions {
  title?: string;
  footer?: string;
  /** Fixed width, 'auto' (content width + padding), or 'full' (terminal width). Default: 'auto'. */
  width?: number | "auto" | "full";
  /** Max width cap for 'auto' mode. Default: 80. */
  maxWidth?: number;
  /** Padding inside borders. */
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
  border?: "single" | "rounded" | "none";
  /** Horizontal alignment of the panel itself. Default: 'left'. */
  align?: "left" | "center";
  borderColor?: (s: string) => string;
  titleColor?: (s: string) => string;
  footerColor?: (s: string) => string;
  /** Terminal width for 'full' mode and centering. If omitted, uses maxWidth. */
  termWidth?: number;
}

// ─── Render ─────────────────────────────────────────────────────────────────

/**
 * Render content lines inside a bordered panel.
 * Returns array of ANSI-styled terminal lines ready for output.
 */
export function renderPanel(options: PanelOptions, contentLines: string[]): string[] {
  const bc = options.borderColor ?? ctp.surface1;
  const tc = options.titleColor ?? ctp.mauve;
  const fc = options.footerColor ?? ctp.overlay0;
  const chars = options.border === "none" ? null : BORDERS[options.border ?? "single"];
  const padL = options.padding?.left ?? 1;
  const padR = options.padding?.right ?? 1;
  const padTop = options.padding?.top ?? 1;
  const padBot = options.padding?.bottom ?? 1;
  const termW = options.termWidth ?? 120;
  const maxW = options.maxWidth ?? 80;

  // ── Determine box width ──────────────────────────────────────────
  let boxW: number;
  const borderW = chars ? 2 : 0; // left + right border chars
  const innerPad = padL + padR;

  if (typeof options.width === "number") {
    boxW = options.width;
  } else if (options.width === "full") {
    boxW = Math.max(termW - 4, 20); // 2-char margin each side
  } else {
    // 'auto' — fit to widest content line + padding + borders
    let widest = 0;
    for (const line of contentLines) {
      const w = visibleWidth(line);
      if (w > widest) widest = w;
    }
    // Account for title/footer width too
    if (options.title) {
      const titleW = visibleWidth(options.title) + 4; // " title " + border chars
      if (titleW > widest) widest = titleW;
    }
    if (options.footer) {
      const footerW = visibleWidth(options.footer) + 2;
      if (footerW > widest) widest = footerW;
    }
    boxW = Math.min(widest + innerPad + borderW, maxW, termW - 4);
  }

  boxW = Math.max(boxW, 10); // minimum sanity

  const contentW = boxW - borderW - innerPad;
  const leftMargin = options.align === "center"
    ? " ".repeat(Math.max(0, Math.floor((termW - boxW) / 2)))
    : "  "; // default 2-char left margin

  if (!chars) {
    // No border — just pad content
    return contentLines.map((line) => leftMargin + " ".repeat(padL) + line);
  }

  const output: string[] = [];

  // ── Top border with optional title ─────────────────────────────
  if (options.title) {
    const titleStr = ` ${options.title} `;
    const titleVisW = visibleWidth(titleStr);
    const rightFill = Math.max(0, boxW - 2 - titleVisW - 1); // -2 for corners, -1 for left dash
    output.push(leftMargin + bc(chars.tl + chars.h) + tc(titleStr) + bc(chars.h.repeat(rightFill) + chars.tr));
  } else {
    output.push(leftMargin + bc(chars.tl + chars.h.repeat(boxW - 2) + chars.tr));
  }

  // ── Top padding ────────────────────────────────────────────────
  const emptyInner = " ".repeat(boxW - 2);
  for (let i = 0; i < padTop; i++) {
    output.push(leftMargin + bc(chars.v) + emptyInner + bc(chars.v));
  }

  // ── Content lines ──────────────────────────────────────────────
  const padLStr = " ".repeat(padL);
  const padRStr = " ".repeat(padR);

  for (const line of contentLines) {
    const lineW = visibleWidth(line);
    let fitted: string;
    if (lineW <= contentW) {
      fitted = line + " ".repeat(contentW - lineW);
    } else {
      fitted = truncate(line, contentW);
      const fittedW = visibleWidth(fitted);
      fitted += " ".repeat(Math.max(0, contentW - fittedW));
    }
    output.push(leftMargin + bc(chars.v) + padLStr + fitted + padRStr + bc(chars.v));
  }

  // ── Bottom padding ─────────────────────────────────────────────
  for (let i = 0; i < padBot; i++) {
    output.push(leftMargin + bc(chars.v) + emptyInner + bc(chars.v));
  }

  // ── Footer in bottom border ────────────────────────────────────
  if (options.footer) {
    // Extra row for footer above bottom border
    const footerStyled = fc(options.footer);
    const footerW = visibleWidth(options.footer);
    const footerFill = Math.max(0, boxW - 2 - padL - footerW);
    output.push(leftMargin + bc(chars.v) + padLStr + footerStyled + " ".repeat(footerFill) + bc(chars.v));
  }

  // ── Bottom border ──────────────────────────────────────────────
  output.push(leftMargin + bc(chars.bl + chars.h.repeat(boxW - 2) + chars.br));

  return output;
}

// ─── Section helpers (used inside panel content) ────────────────────────────

/**
 * Render a section header inside a panel.
 */
export function panelSection(title: string, width = 50): string[] {
  return [
    ctp.text(title),
    separator({ width: Math.min(width, 50), color: ctp.surface1 }),
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
  const prefix = opts.selected ? ctp.mauve("\u276f ") : "  ";
  const nameColor = (opts.selected || opts.hovered) ? ctp.text : ctp.subtext1;
  const valueColor = (opts.selected || opts.hovered) ? ctp.subtext1 : ctp.overlay1;

  return prefix + labelValue(label, value + (opts.hint ? "  " + ctp.overlay0(opts.hint) : ""), {
    labelWidth: 16,
    labelColor: nameColor,
    valueColor,
    gap: 1,
  });
}
