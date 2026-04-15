/**
 * Helper to build Theme objects from hex color palettes.
 */
import type { Theme, StyleFn } from "../theme.js";
import type { ThemePalette, ThemeDefinition } from "../theme-types.js";
import { bold, italic, underline } from "../../core/ansi.js";
import { ICONS } from "../../constants/icons.js";

/** Convert hex "#RRGGBB" to RGB tuple. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Create a foreground StyleFn from hex. */
export function fg(hex: string): StyleFn {
  const [r, g, b] = hexToRgb(hex);
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

/** Create a background StyleFn from hex. */
export function bg(hex: string): StyleFn {
  const [r, g, b] = hexToRgb(hex);
  return (s: string) => `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m`;
}

/** Create a combined fg+bg StyleFn. */
export function fgBg(fgHex: string, bgHex: string): StyleFn {
  const [fr, fg2, fb] = hexToRgb(fgHex);
  const [br, bg2, bb] = hexToRgb(bgHex);
  return (s: string) => `\x1b[38;2;${fr};${fg2};${fb};48;2;${br};${bg2};${bb}m${s}\x1b[0m`;
}

/** Build a full Theme from a palette. */
export function buildTheme(
  id: string,
  name: string,
  author: string,
  variant: "dark" | "light",
  p: ThemePalette,
): ThemeDefinition {
  const theme: Theme = {
    primary: fg(p.info),
    secondary: fg(p.textSecondary),
    success: fg(p.success),
    warning: fg(p.warning),
    error: fg(p.error),
    info: fg(p.info),
    accent: fg(p.toolRunning),
    dim: fg(p.textMuted),
    muted: fg(p.textSecondary),
    bold,
    italic,
    underline,

    agentColors: [
      fg(p.agentCoder),
      fg(p.agentReviewer),
      fg(p.agentDebugger),
      fg(p.agentTester),
      fg(p.agentPlanner),
      fg(p.agentResearcher),
      fg(p.agentAssistant),
    ],

    border: { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘" },

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

    markdown: {
      heading: (s) => bold(fg(p.info)(s)),
      code: fg(p.codeInline),
      codeBlock: fg(p.textPrimary),
      link: (s) => underline(fg(p.link)(s)),
      blockquote: (s) => fg(p.textMuted)(`│ ${s}`),
    },

    userBubble: fgBg(p.userMessage, p.codeBlockBorder),
    agentName: (s) => bold(fg(p.agentResponse)(s)),
    agentResponseBg: bg(p.agentResponseBg),
    toolApprovalBg: bg(p.toolApprovalBg),

    statusBarBg: bg(p.statusBarBg),
    statusMode: fg(p.statusBarAccent),
    statusWorking: fg(p.warning),

    logo: fg(p.prompt),
    logoBorder: fg(p.panelBorder),
  };

  return { id, name, author, variant, palette: p, theme };
}
