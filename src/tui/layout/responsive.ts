/**
 * Responsive layout system — CSS-like breakpoints for terminals.
 * Pure functions, no side effects.
 */

export type Breakpoint = "xs" | "sm" | "md" | "lg";
export type HeightBreakpoint = "short" | "medium" | "tall";

export interface LayoutConfig {
  breakpoint: Breakpoint;
  heightBreakpoint: HeightBreakpoint;
  cols: number;
  rows: number;

  /** Max visible lines in the input editor. */
  maxInputLines: number;
  /** Max visible items in select lists / interactive views. */
  maxSelectItems: number;
  /** Whether to render box-drawing borders on components. */
  showBorder: boolean;
  /** Whether the ASCII art banner fits. */
  showAsciiArt: boolean;
  /** Content padding inside message bubbles (chars). */
  contentPadding: number;
  /** Message bubble width as fraction of terminal width. */
  messageBubblePercent: number;
  /** Max visible items in autocomplete popup. */
  maxAutocompleteItems: number;
}

/** Minimum terminal dimensions — below this, show a "resize" overlay instead of the UI. */
export const MIN_COLS = 60;
export const MIN_ROWS = 15;

const WIDTH_THRESHOLDS = { xs: 60, sm: 80, md: 120 } as const;
const HEIGHT_THRESHOLDS = { short: 20, medium: 35 } as const;

export function getBreakpoint(cols: number): Breakpoint {
  if (cols < WIDTH_THRESHOLDS.xs) return "xs";
  if (cols < WIDTH_THRESHOLDS.sm) return "sm";
  if (cols < WIDTH_THRESHOLDS.md) return "md";
  return "lg";
}

export function getHeightBreakpoint(rows: number): HeightBreakpoint {
  if (rows < HEIGHT_THRESHOLDS.short) return "short";
  if (rows < HEIGHT_THRESHOLDS.medium) return "medium";
  return "tall";
}

const INPUT_LINES: Record<Breakpoint, number> = { xs: 3, sm: 5, md: 8, lg: 10 };
const SELECT_ITEMS: Record<Breakpoint, number> = { xs: 6, sm: 8, md: 10, lg: 12 };
const CONTENT_PADDING: Record<Breakpoint, number> = { xs: 0, sm: 1, md: 2, lg: 3 };
const BUBBLE_PERCENT: Record<Breakpoint, number> = { xs: 0.95, sm: 0.80, md: 0.70, lg: 0.60 };
const AUTOCOMPLETE_ITEMS: Record<Breakpoint, number> = { xs: 4, sm: 6, md: 8, lg: 10 };

export function computeLayout(cols: number, rows: number): LayoutConfig {
  const bp = getBreakpoint(cols);
  return {
    breakpoint: bp,
    heightBreakpoint: getHeightBreakpoint(rows),
    cols,
    rows,
    maxInputLines: INPUT_LINES[bp],
    maxSelectItems: SELECT_ITEMS[bp],
    showBorder: bp !== "xs",
    showAsciiArt: bp === "md" || bp === "lg",
    contentPadding: CONTENT_PADDING[bp],
    messageBubblePercent: BUBBLE_PERCENT[bp],
    maxAutocompleteItems: AUTOCOMPLETE_ITEMS[bp],
  };
}

/** Default layout for fallback when no provider is set. */
export const DEFAULT_LAYOUT: LayoutConfig = computeLayout(80, 24);
