/**
 * Single source of truth for all Unicode symbols used across the TUI.
 * Import ICONS instead of hardcoding Unicode literals.
 */

export const ICONS = {
  // Status indicators
  success: "\u2713",     // ✓
  error: "\u2717",       // ✗
  warning: "\u26a0",     // ⚠

  // Navigation / pointers
  cursor: "\u25b8",      // ▸
  expand: "\u25be",      // ▾
  arrow: "\u2192",       // →
  arrowLeft: "\u2190",   // ←
  arrowUp: "\u2191",     // ↑
  arrowDown: "\u2193",   // ↓

  // Shapes
  diamond: "\u25c6",     // ◆
  bullet: "\u2022",      // •
  block: "\u2588",       // █

  // Dots (status indicators)
  dotFilled: "\u25cf",   // ●
  dotEmpty: "\u25cb",    // ○
  dotHalf: "\u25d0",     // ◐

  // Scroll indicators
  scrollUp: "\u25b2",    // ▲
  scrollDown: "\u25bc",  // ▼

  // Mode icons (solo/crew)
  bolt: "\u26a1",               // ⚡
  modeSolo: "\u203a",           // ›
  modeCrew: "\u26a1",           // ⚡

  // Spinners
  spinnerFrames: ["\u25d2", "\u25d0", "\u25d3", "\u25d1"] as readonly string[], // ◒ ◐ ◓ ◑
  brailleFrames: ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"] as readonly string[],
  // ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏

  // Misc
  aborted: "\u25fc",     // ◼
  hourglass: "\u23f3",   // ⏳
  memo: "\ud83d\udcdd",  // 📝
  gear: "\u2699",        // ⚙
} as const;

export type IconKey = keyof typeof ICONS;
