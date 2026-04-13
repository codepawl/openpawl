/**
 * Convert raw terminal ANSI output to SVG.
 * Self-contained — no external dependencies.
 *
 * Parses ANSI escape sequences, renders a terminal-style SVG with
 * Catppuccin Mocha colors matching the app's actual theme.
 */

// ── Catppuccin Mocha palette ────────────────────────────────────────────────

const PALETTE: Record<string, string> = {
  bg: "#1e1e2e",
  fg: "#cdd6f4",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#cba6f7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

const ANSI_COLORS = [
  PALETTE.black, PALETTE.red, PALETTE.green, PALETTE.yellow,
  PALETTE.blue, PALETTE.magenta, PALETTE.cyan, PALETTE.white,
];

const ANSI_BRIGHT = [
  PALETTE.brightBlack, PALETTE.brightRed, PALETTE.brightGreen, PALETTE.brightYellow,
  PALETTE.brightBlue, PALETTE.brightMagenta, PALETTE.brightCyan, PALETTE.brightWhite,
];

// ── ANSI parser ─────────────────────────────────────────────────────────────

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function defaultStyle(): Style {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

interface Span {
  text: string;
  style: Style;
}

/**
 * Parse an ANSI-styled string into an array of styled spans per line.
 * Handles CSI SGR sequences (colors, bold, dim, italic, underline, reset).
 */
function parseAnsiLine(line: string): Span[] {
  const spans: Span[] = [];
  const style = defaultStyle();
  let buf = "";

  const flush = () => {
    if (buf.length > 0) {
      spans.push({ text: buf, style: { ...style } });
      buf = "";
    }
  };

  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      flush();
      // Parse CSI sequence
      let j = i + 2;
      while (j < line.length && line[j] !== "m" && !/[A-Za-z]/.test(line[j]!)) j++;
      if (line[j] === "m") {
        const params = line.slice(i + 2, j).split(";").map(Number);
        applyParams(style, params);
      }
      i = j + 1;
    } else if (line.charCodeAt(i) < 32 && line[i] !== "\t") {
      // Skip other control chars
      i++;
    } else {
      buf += line[i];
      i++;
    }
  }
  flush();
  return spans;
}

function applyParams(style: Style, params: number[]): void {
  let i = 0;
  while (i < params.length) {
    const p = params[i]!;
    if (p === 0) { Object.assign(style, defaultStyle()); }
    else if (p === 1) { style.bold = true; }
    else if (p === 2) { style.dim = true; }
    else if (p === 3) { style.italic = true; }
    else if (p === 4) { style.underline = true; }
    else if (p === 22) { style.bold = false; style.dim = false; }
    else if (p === 23) { style.italic = false; }
    else if (p === 24) { style.underline = false; }
    else if (p === 39) { style.fg = null; }
    else if (p === 49) { style.bg = null; }
    else if (p >= 30 && p <= 37) { style.fg = ANSI_COLORS[p - 30]!; }
    else if (p >= 40 && p <= 47) { style.bg = ANSI_COLORS[p - 40]!; }
    else if (p >= 90 && p <= 97) { style.fg = ANSI_BRIGHT[p - 90]!; }
    else if (p >= 100 && p <= 107) { style.bg = ANSI_BRIGHT[p - 100]!; }
    else if (p === 38 && params[i + 1] === 2) {
      // 24-bit foreground: 38;2;R;G;B
      const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
      style.fg = `#${hex(r)}${hex(g)}${hex(b)}`;
      i += 4;
    } else if (p === 48 && params[i + 1] === 2) {
      // 24-bit background: 48;2;R;G;B
      const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
      style.bg = `#${hex(r)}${hex(g)}${hex(b)}`;
      i += 4;
    } else if (p === 38 && params[i + 1] === 5) {
      style.fg = color256(params[i + 2] ?? 0);
      i += 2;
    } else if (p === 48 && params[i + 1] === 5) {
      style.bg = color256(params[i + 2] ?? 0);
      i += 2;
    }
    i++;
  }
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function color256(n: number): string {
  if (n < 8) return ANSI_COLORS[n]!;
  if (n < 16) return ANSI_BRIGHT[n - 8]!;
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36) * 51;
    const g = Math.floor((idx % 36) / 6) * 51;
    const b = (idx % 6) * 51;
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  const gray = 8 + (n - 232) * 10;
  return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
}

// ── SVG renderer ────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface SvgOptions {
  title?: string;
  columns?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  padding?: number;
  borderRadius?: number;
  showWindowButtons?: boolean;
}

/**
 * Convert an array of ANSI-styled lines to an SVG string.
 */
export function ansiToSvg(lines: string[], options: SvgOptions = {}): string {
  const {
    title = "openpawl",
    columns = 100,
    rows = 30,
    fontSize = 14,
    fontFamily = "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
    padding = 16,
    borderRadius = 8,
    showWindowButtons = true,
  } = options;

  const charWidth = fontSize * 0.6;
  const lineHeight = fontSize * 1.5;
  const titleBarHeight = showWindowButtons ? 36 : 0;
  const contentWidth = columns * charWidth + padding * 2;
  const contentHeight = rows * lineHeight + padding * 2 + titleBarHeight;

  const svgParts: string[] = [];

  // SVG header
  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${contentWidth} ${contentHeight}" width="${contentWidth}" height="${contentHeight}">`);
  svgParts.push(`<style>`);
  svgParts.push(`text { font-family: ${fontFamily}; font-size: ${fontSize}px; white-space: pre; }`);
  svgParts.push(`</style>`);

  // Background
  svgParts.push(`<rect width="100%" height="100%" rx="${borderRadius}" fill="${PALETTE.bg}"/>`);

  // Window title bar with buttons
  if (showWindowButtons) {
    const btnY = 18;
    svgParts.push(`<circle cx="${padding + 6}" cy="${btnY}" r="6" fill="#f38ba8"/>`);
    svgParts.push(`<circle cx="${padding + 24}" cy="${btnY}" r="6" fill="#f9e2af"/>`);
    svgParts.push(`<circle cx="${padding + 42}" cy="${btnY}" r="6" fill="#a6e3a1"/>`);
    if (title) {
      svgParts.push(`<text x="${contentWidth / 2}" y="${btnY + 4}" text-anchor="middle" fill="${PALETTE.brightBlack}">${escapeXml(title)}</text>`);
    }
  }

  // Render lines
  const displayLines = lines.slice(0, rows);
  for (let row = 0; row < displayLines.length; row++) {
    const spans = parseAnsiLine(displayLines[row]!);
    let x = padding;
    const y = titleBarHeight + padding + (row + 1) * lineHeight - fontSize * 0.3;

    for (const span of spans) {
      if (span.text.length === 0) continue;

      const fg = span.style.fg ?? PALETTE.fg;
      const opacity = span.style.dim ? 0.6 : 1;
      const weight = span.style.bold ? "bold" : "normal";
      const fontStyle = span.style.italic ? "italic" : "normal";

      // Background rect
      if (span.style.bg) {
        const bgWidth = span.text.length * charWidth;
        svgParts.push(`<rect x="${x}" y="${y - fontSize}" width="${bgWidth}" height="${lineHeight}" fill="${span.style.bg}"/>`);
      }

      // Text with optional underline
      let decoration = "";
      if (span.style.underline) decoration = ` text-decoration="underline"`;

      svgParts.push(
        `<text x="${x}" y="${y}" fill="${fg}" opacity="${opacity}" font-weight="${weight}" font-style="${fontStyle}"${decoration}>${escapeXml(span.text)}</text>`,
      );

      x += span.text.length * charWidth;
    }
  }

  svgParts.push(`</svg>`);
  return svgParts.join("\n");
}

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Parse raw terminal output into clean display lines.
 * Handles cursor movement, clear-line, and CSI 2026 sync markers.
 */
export function parseTerminalOutput(raw: string, rows: number, _columns: number): string[] {
  // Strip CSI 2026 sync markers and alt-screen sequences
  const cleaned = raw
    .replace(/\x1b\[\?2026[hl]/g, "")     // synchronized output
    .replace(/\x1b\[\?1049[hl]/g, "")     // alt screen
    .replace(/\x1b\[\?1000[hl]/g, "")     // mouse tracking
    .replace(/\x1b\[\?1002[hl]/g, "")
    .replace(/\x1b\[\?1003[hl]/g, "")
    .replace(/\x1b\[\?1006[hl]/g, "")
    .replace(/\x1b\[\?25[hl]/g, "")       // cursor visibility
    .replace(/\x1b\[\?2004[hl]/g, "");    // bracketed paste

  // Build virtual screen buffer
  const screen: string[] = new Array(rows).fill("");
  let curRow = 0;
  let curCol = 0;

  let i = 0;
  while (i < cleaned.length) {
    if (cleaned[i] === "\x1b" && cleaned[i + 1] === "[") {
      // Parse CSI sequence
      let j = i + 2;
      let paramStr = "";
      while (j < cleaned.length && /[0-9;]/.test(cleaned[j]!)) {
        paramStr += cleaned[j];
        j++;
      }
      const cmd = cleaned[j];
      const params = paramStr ? paramStr.split(";").map(Number) : [];

      if (cmd === "H") {
        // Cursor position: ESC[row;colH
        curRow = Math.max(0, (params[0] ?? 1) - 1);
        curCol = Math.max(0, (params[1] ?? 1) - 1);
      } else if (cmd === "K") {
        // Erase in line
        const mode = params[0] ?? 0;
        if (mode === 0 || mode === 2) {
          // Erase from cursor to end (or entire line)
          const line = screen[curRow] ?? "";
          // Keep the content up to cursor, pad with spaces for ANSI spans
          screen[curRow] = line.slice(0, curCol);
        }
      } else if (cmd === "J") {
        // Erase in display
        const mode = params[0] ?? 0;
        if (mode === 2) {
          for (let r = 0; r < rows; r++) screen[r] = "";
          curRow = 0; curCol = 0;
        } else if (mode === 0) {
          screen[curRow] = (screen[curRow] ?? "").slice(0, curCol);
          for (let r = curRow + 1; r < rows; r++) screen[r] = "";
        }
      } else if (cmd === "m") {
        // SGR — insert the escape sequence literally so ANSI parser handles it later
        const seq = cleaned.slice(i, j + 1);
        const line = screen[curRow] ?? "";
        screen[curRow] = line.slice(0, curCol) + seq + line.slice(curCol);
        curCol += seq.length;  // ANSI sequences are zero-width visually, but we keep them in the string
      } else if (cmd === "A") { curRow = Math.max(0, curRow - (params[0] ?? 1)); }
      else if (cmd === "B") { curRow = Math.min(rows - 1, curRow + (params[0] ?? 1)); }
      else if (cmd === "C") { curCol += params[0] ?? 1; }
      else if (cmd === "D") { curCol = Math.max(0, curCol - (params[0] ?? 1)); }

      i = j + 1;
    } else if (cleaned[i] === "\n") {
      curRow = Math.min(rows - 1, curRow + 1);
      curCol = 0;
      i++;
    } else if (cleaned[i] === "\r") {
      curCol = 0;
      i++;
    } else {
      // Regular character — write to screen buffer
      const line = screen[curRow] ?? "";
      if (curCol >= line.length) {
        screen[curRow] = line + " ".repeat(curCol - line.length) + cleaned[i];
      } else {
        screen[curRow] = line.slice(0, curCol) + cleaned[i] + line.slice(curCol + 1);
      }
      curCol++;
      i++;
    }
  }

  return screen;
}
