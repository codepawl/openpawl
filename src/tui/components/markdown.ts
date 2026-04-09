/**
 * Markdown renderer — converts markdown text to ANSI-styled terminal lines.
 * Supports: headers, bold, italic, inline code, code blocks with syntax
 * highlighting, bullet/numbered lists, blockquotes, links, horizontal rules.
 */
import type { Component } from "../core/component.js";
import { bold, italic, dim, bgRgb } from "../core/ansi.js";
import { wrapText } from "../utils/wrap.js";
import { visibleWidth } from "../utils/text-width.js";
import { truncate } from "../utils/truncate.js";
import { defaultTheme, ctp } from "../themes/default.js";
import { highlight } from "cli-highlight";

// Code block background — Catppuccin mantle (#181825)
const bgCodeBlock = bgRgb(0x18, 0x18, 0x25);

export class MarkdownComponent implements Component {
  readonly id: string;
  private content: string;

  constructor(id: string, content = "") {
    this.id = id;
    this.content = content;
  }

  render(width: number): string[] {
    return renderMarkdown(this.content, width);
  }

  setContent(content: string): void {
    this.content = content;
  }
}

/** Render markdown string to ANSI-styled lines. */
export function renderMarkdown(md: string, width: number): string[] {
  const lines = md.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];
  let tableLines: string[] = [];

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        codeBlockLines = [];
        // Blank line before code block for spacing
        ensureBlankLine(result);
      } else {
        // Closing fence — emit highlighted code block
        emitCodeBlock(result, codeBlockLines, codeBlockLang, width);
        inCodeBlock = false;
        codeBlockLang = "";
        codeBlockLines = [];
        // Blank line after code block
        result.push("");
      }
      continue;
    }

    // Inside code block — collect lines
    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Horizontal rule — just extra spacing (headings provide enough structure)
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      ensureBlankLine(result);
      result.push("");
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      const text = processInline(headerMatch[2]!);
      // Blank line before heading (unless first line)
      ensureBlankLine(result);
      if (level === 1) {
        result.push(bold(ctp.mauve(text)));
      } else if (level === 2) {
        result.push(bold(ctp.sapphire(text)));
      } else {
        result.push(bold(ctp.subtext1(text)));
      }
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const content = line.slice(2);
      const wrapped = wrapText(processInline(content), width - 4);
      for (const wl of wrapped) {
        result.push("  " + ctp.surface2("│") + " " + ctp.subtext0(wl));
      }
      continue;
    }

    // Bullet list
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (bulletMatch) {
      const indent = bulletMatch[1]!;
      const text = bulletMatch[2]!;
      const bulletIndent = indent + "  ";
      const wrapped = wrapText(processInline(text), width - bulletIndent.length - 2);
      wrapped.forEach((wl, i) => {
        const prefix = i === 0 ? bulletIndent + ctp.overlay0("• ") : bulletIndent + "  ";
        result.push(prefix + wl);
      });
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (numMatch) {
      const indent = numMatch[1]!;
      const num = numMatch[2]!;
      const text = numMatch[3]!;
      const numPrefix = indent + "  ";
      const wrapped = wrapText(processInline(text), width - numPrefix.length - num.length - 2);
      wrapped.forEach((wl, i) => {
        const prefix = i === 0 ? numPrefix + ctp.overlay0(num + ".") + " " : numPrefix + " ".repeat(num.length + 2);
        result.push(prefix + wl);
      });
      continue;
    }

    // Table row — collect consecutive pipe-delimited lines
    if (/^\|.+\|$/.test(line.trim())) {
      tableLines.push(line.trim());
      continue;
    }

    // Flush accumulated table lines if current line breaks the pattern
    if (tableLines.length > 0) {
      emitTable(result, tableLines, width);
      tableLines = [];
      // Fall through to process current line normally
    }

    // Empty line
    if (line.trim() === "") {
      result.push("");
      continue;
    }

    // Regular paragraph
    const processed = processInline(line);
    result.push(...wrapText(processed, width));
  }

  // Flush remaining table lines
  if (tableLines.length > 0) {
    emitTable(result, tableLines, width);
  }

  // Close unclosed code block (streaming)
  if (inCodeBlock) {
    emitCodeBlock(result, codeBlockLines, codeBlockLang, width);
  }

  return result;
}

/** Ensure the last line in result is blank (avoid double-spacing). */
function ensureBlankLine(result: string[]): void {
  if (result.length > 0 && result[result.length - 1] !== "") {
    result.push("");
  }
}

/** Emit a code block with background color and optional syntax highlighting. */
function emitCodeBlock(result: string[], lines: string[], lang: string, width: number): void {
  const codeWidth = width - 4; // 2 padding each side
  const highlighted = highlightCodeBlock(lines, lang);

  // Language label line (dim, right side)
  if (lang) {
    const labelPad = Math.max(0, width - lang.length - 2);
    result.push(bgCodeBlock(" ".repeat(labelPad) + dim(ctp.overlay1(lang)) + "  "));
  } else {
    result.push(bgCodeBlock(" ".repeat(width)));
  }

  // Code lines with background
  for (const hl of highlighted) {
    if (visibleWidth(hl) > codeWidth) {
      for (const wl of wrapText(hl, codeWidth)) {
        const pad = Math.max(0, width - visibleWidth(wl) - 4);
        result.push(bgCodeBlock("  " + wl + " ".repeat(pad) + "  "));
      }
    } else {
      const pad = Math.max(0, width - visibleWidth(hl) - 4);
      result.push(bgCodeBlock("  " + hl + " ".repeat(pad) + "  "));
    }
  }

  // Bottom padding line
  result.push(bgCodeBlock(" ".repeat(width)));
}

// ── Table rendering ────────────────────────────────────────────────────────────

/** Parse pipe-delimited table lines into headers and rows. */
function parseTable(lines: string[]): { headers: string[]; rows: string[][] } | null {
  if (lines.length < 2) return null;

  const parseCells = (line: string): string[] =>
    line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());

  const headers = parseCells(lines[0]!);

  // Verify separator line (line[1] must be all dashes/colons)
  const sepCells = parseCells(lines[1]!);
  if (!sepCells.every(c => /^:?-+:?$/.test(c))) return null;

  const rows = lines.slice(2).map(parseCells);
  return { headers, rows };
}

/** Emit a markdown table as aligned columns without pipe characters. */
function emitTable(result: string[], tableLines: string[], width: number): void {
  const table = parseTable(tableLines);
  if (!table) {
    // Not a valid table — emit as regular paragraph lines
    for (const line of tableLines) {
      result.push(...wrapText(processInline(line), width));
    }
    return;
  }

  const { headers, rows } = table;
  const colCount = headers.length;
  const gap = 2;

  // Measure max content width per column
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = visibleWidth(headers[c] ?? "");
    for (const row of rows) {
      max = Math.max(max, visibleWidth(row[c] ?? ""));
    }
    colWidths[c] = max;
  }

  // Shrink proportionally if total exceeds available width
  const totalNeeded = colWidths.reduce((s, w) => s + w, 0) + gap * (colCount - 1);
  if (totalNeeded > width) {
    const ratio = width / totalNeeded;
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(3, Math.floor(colWidths[c]! * ratio));
    }
  }

  const gapStr = " ".repeat(gap);

  const renderCell = (text: string, w: number, asBold: boolean): string => {
    const processed = processInline(text);
    const vis = visibleWidth(processed);
    if (vis > w) return truncate(asBold ? bold(processed) : processed, w);
    const padded = processed + " ".repeat(w - vis);
    return asBold ? bold(padded) : padded;
  };

  // Header row (bold)
  const headerCells = headers.map((h, c) => renderCell(h, colWidths[c]!, true));
  result.push(headerCells.join(gapStr));

  // Separator row (dim dashes)
  const sepCells = colWidths.map(w => ctp.overlay0("─".repeat(w)));
  result.push(sepCells.join(gapStr));

  // Data rows
  for (const row of rows) {
    const cells = row.map((cell, c) => renderCell(cell ?? "", colWidths[c]!, false));
    result.push(cells.join(gapStr));
  }
}

/** Syntax-highlight a code block. Only highlights if a language tag is present. */
function highlightCodeBlock(lines: string[], lang: string): string[] {
  if (!lang) return lines;
  try {
    const code = lines.join("\n");
    const highlighted = highlight(code, { language: lang, ignoreIllegals: true });
    return highlighted.split("\n");
  } catch {
    return lines;
  }
}

/** Process inline markdown: bold, italic, code, links. */
function processInline(text: string): string {
  let result = text;

  // Inline code: `code` — warm accent color, no syntax highlighting
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    return ctp.rosewater(code);
  });

  // Bold+italic: ***text***
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, (_match, t: string) => bold(italic(t)));

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, (_match, t: string) => bold(ctp.subtext1(t)));

  // Italic: *text*
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_match, t: string) => italic(t));

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, (_match, t: string) => `\x1b[9m${t}\x1b[29m`);

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) => {
    return `\x1b]8;;${url}\x1b\\${defaultTheme.markdown.link(text)}\x1b]8;;\x1b\\`;
  });

  return result;
}
