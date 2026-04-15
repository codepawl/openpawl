/**
 * Shared status indicators — single source of truth for status dots
 * and inline loading spinners across all TUI views.
 */
import { ctp } from "../themes/default.js";
import { ICONS } from "../constants/icons.js";

// ── Status Dots ──────────────────────────────────────────────────

const STATUS_DOT = {
  active:       { symbol: ICONS.dotFilled, color: ctp.green },     // ● green — currently in use
  configured:   { symbol: ICONS.dotFilled, color: ctp.yellow },    // ● yellow — set up but not active
  offline:      { symbol: ICONS.dotFilled, color: ctp.overlay0 },  // ● dim — unreachable
  unconfigured: { symbol: ICONS.dotEmpty,  color: ctp.overlay0 },  // ○ dim — not set up
  error:        { symbol: ICONS.dotFilled, color: ctp.red },       // ● red — failed
  ready:        { symbol: ICONS.dotFilled, color: ctp.blue },      // ● blue — ready, not yet connected
  connecting:   { symbol: ICONS.dotHalf,   color: ctp.overlay0 },  // ◐ dim — connecting
} as const;

export type StatusDotKind = keyof typeof STATUS_DOT;

/** Raw dot symbols (uncolored) for contexts where color is applied externally. */
export const DOT_SYMBOL = {
  filled: ICONS.dotFilled,  // ●
  empty:  ICONS.dotEmpty,   // ○
  half:   ICONS.dotHalf,    // ◐
} as const;

/** Render a colored status dot for the given status. */
export function statusDot(status: StatusDotKind): string {
  const s = STATUS_DOT[status];
  return s.color(s.symbol);
}

// ── Inline Spinner ───────────────────────────────────────────────

const BRAILLE_FRAMES = ICONS.brailleFrames;

export interface InlineSpinner {
  /** Returns the current spinner frame string (colored). */
  frame(): string;
  /** Stops the animation interval. Must be called to avoid leaks. */
  stop(): void;
}

/**
 * Create a lightweight inline spinner that auto-advances every 80ms.
 * Call `frame()` each render to get the current character.
 * Call `stop()` when loading is complete.
 */
export function createSpinner(colorFn?: (s: string) => string): InlineSpinner {
  const color = colorFn ?? ctp.teal;
  let idx = 0;

  const timer = setInterval(() => { idx++; }, 80);
  // Don't block process exit
  if (timer.unref) timer.unref();

  return {
    frame() {
      return color(BRAILLE_FRAMES[idx % BRAILLE_FRAMES.length]!);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
