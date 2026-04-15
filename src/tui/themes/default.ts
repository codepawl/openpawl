/**
 * Default theme — Catppuccin Mocha.
 * Exact hex values from github.com/catppuccin (MIT license).
 * Warm dark palette with pastel accents, optimized for long coding sessions.
 */
import { rgb, bgRgb, bold, italic, underline } from "../core/ansi.js";
import type { Theme } from "./theme.js";
import { ICONS } from "../constants/icons.js";

// ── Catppuccin Mocha palette ─────────────────────────────────────
const ctp = {
  rosewater: rgb(0xf5, 0xe0, 0xdc),
  flamingo:  rgb(0xf2, 0xcd, 0xcd),
  pink:      rgb(0xf5, 0xc2, 0xe7),
  mauve:     rgb(0xcb, 0xa6, 0xf7),
  red:       rgb(0xf3, 0x8b, 0xa8),
  maroon:    rgb(0xeb, 0xa0, 0xac),
  peach:     rgb(0xfa, 0xb3, 0x87),
  yellow:    rgb(0xf9, 0xe2, 0xaf),
  green:     rgb(0xa6, 0xe3, 0xa1),
  teal:      rgb(0x94, 0xe2, 0xd5),
  sky:       rgb(0x89, 0xdc, 0xeb),
  sapphire:  rgb(0x74, 0xc7, 0xec),
  blue:      rgb(0x89, 0xb4, 0xfa),
  lavender:  rgb(0xb4, 0xbe, 0xfe),
  text:      rgb(0xcd, 0xd6, 0xf4),
  subtext1:  rgb(0xba, 0xc2, 0xde),
  subtext0:  rgb(0xa6, 0xad, 0xc8),
  overlay2:  rgb(0x93, 0x99, 0xb2),
  overlay1:  rgb(0x7f, 0x84, 0x9c),
  overlay0:  rgb(0x6c, 0x70, 0x86),
  surface2:  rgb(0x58, 0x5b, 0x70),
  surface1:  rgb(0x45, 0x47, 0x5a),
  surface0:  rgb(0x31, 0x32, 0x44),
  base:      rgb(0x1e, 0x1e, 0x2e),
  mantle:    rgb(0x18, 0x18, 0x25),
  crust:     rgb(0x11, 0x11, 0x1b),
};

// Background variants
const bgMantle  = bgRgb(0x18, 0x18, 0x25);
const bgSurface0 = bgRgb(0x31, 0x32, 0x44);

const catppuccinMochaTheme: Theme = {
  // Semantic styles
  primary: ctp.blue,
  secondary: ctp.subtext1,
  success: ctp.green,
  warning: ctp.yellow,
  error: ctp.red,
  info: ctp.sapphire,
  accent: ctp.teal,
  dim: ctp.overlay0,
  muted: ctp.overlay1,
  bold,
  italic,
  underline,

  // Agent colors — each agent gets a distinct Catppuccin accent
  agentColors: [
    ctp.mauve,     // coder
    ctp.green,     // reviewer
    ctp.pink,      // debugger
    ctp.peach,     // tester
    ctp.blue,      // planner
    ctp.yellow,    // researcher
    ctp.overlay2,  // assistant
    ctp.teal,      // custom agents fallback
  ],

  // Box-drawing characters
  border: { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘" },

  // UI symbols
  symbols: {
    spinner: ICONS.spinnerFrames as unknown as string[],
    success: ICONS.success,
    error: ICONS.error,
    warning: ICONS.warning,
    arrow: ICONS.arrow,
    bullet: ICONS.dotFilled,
    pending: ICONS.dotEmpty,
    selected: "❯",
  },

  // Markdown rendering
  markdown: {
    heading: (s) => bold(ctp.blue(s)),
    code: ctp.peach,
    codeBlock: (s) => bgSurface0(ctp.text(s)),
    link: (s) => underline(ctp.lavender(s)),
    blockquote: (s) => ctp.overlay1(`│ ${s}`),
  },

  // Chat — user bubble: text on surface0 bg
  userBubble: (s) => `\x1b[38;2;205;214;244;48;2;49;50;68m${s}\x1b[0m`,
  // Agent name: bold + subtext1
  agentName: (s) => bold(ctp.subtext1(s)),
  // Background tint for user messages — barely visible, close to base (#1e1e2e)
  agentResponseBg: bgRgb(0x1f, 0x1f, 0x2b),
  // Tool approval background — faint warm purple tint
  toolApprovalBg: bgRgb(0x26, 0x22, 0x30),

  // Status bar — mantle background
  statusBarBg: bgMantle,
  statusMode: ctp.mauve,
  statusWorking: ctp.teal,

  // Logo — brand mauve
  logo: ctp.mauve,
  logoBorder: ctp.surface1,
};

/**
 * Active theme proxy — delegates to ThemeEngine's current theme.
 * All existing `import { defaultTheme }` automatically route through the engine.
 * When theme switches, all components see the new theme without re-importing.
 */
let _activeTheme: Theme = catppuccinMochaTheme;

/** Set the active theme (called by ThemeEngine on switch). */
export function setActiveTheme(theme: Theme): void {
  _activeTheme = theme;
}

/** The default theme export — reads from the active theme. */
export const defaultTheme: Theme = new Proxy({} as Theme, {
  get(_target, prop: string) {
    return (_activeTheme as unknown as Record<string, unknown>)[prop];
  },
});

// ── Convenience re-exports for direct use in app code ────────────
export { ctp };
