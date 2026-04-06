/**
 * Text selection manager — content-based selection that survives scrolling.
 * Stores selection as absolute content row/col (not screen coordinates).
 * Converts to screen coordinates at render time based on current scroll offset.
 */
import type { Terminal } from "./terminal.js";
import { stripAnsi } from "../utils/text-width.js";

export interface Selection {
  startRow: number;   // absolute content row (1-based)
  startCol: number;   // column (1-based)
  endRow: number;     // absolute content row (1-based)
  endCol: number;     // column (1-based)
}

export class SelectionManager {
  private selection: Selection | null = null;
  private selecting = false;
  /** Current scroll offset — set by TUI before each render. */
  private scrollOffset = 0;

  /** Update scroll offset (called by TUI on scroll/render). */
  setScrollOffset(offset: number): void {
    this.scrollOffset = offset;
  }

  /** Get current scroll offset (for debug). */
  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /** Convert screen row to absolute content row. */
  private screenToContent(screenRow: number): number {
    return screenRow + this.scrollOffset;
  }

  /** Convert absolute content row to screen row. Returns null if not visible. */
  private contentToScreen(contentRow: number): number | null {
    const screen = contentRow - this.scrollOffset;
    return screen >= 1 ? screen : null;
  }

  startSelection(screenRow: number, col: number): void {
    const contentRow = this.screenToContent(screenRow);
    this.selection = { startRow: contentRow, startCol: col, endRow: contentRow, endCol: col };
    this.selecting = true;
  }

  updateSelection(screenRow: number, col: number): void {
    if (!this.selecting || !this.selection) return;
    this.selection.endRow = this.screenToContent(screenRow);
    this.selection.endCol = col;
  }

  endSelection(): void {
    this.selecting = false;
  }

  getSelection(): Selection | null {
    return this.selection;
  }

  hasSelection(): boolean {
    return this.selection !== null;
  }

  isSelecting(): boolean {
    return this.selecting;
  }

  clearSelection(): void {
    this.selection = null;
    this.selecting = false;
  }

  /** Check if a SCREEN cell (1-based row, 1-based col) is within the selection. */
  isSelected(screenRow: number, col: number): boolean {
    if (!this.selection) return false;
    const contentRow = this.screenToContent(screenRow);
    const s = this.normalize(this.selection);

    if (contentRow < s.startRow || contentRow > s.endRow) return false;
    if (contentRow === s.startRow && contentRow === s.endRow) {
      return col >= s.startCol && col <= s.endCol;
    }
    if (contentRow === s.startRow) return col >= s.startCol;
    if (contentRow === s.endRow) return col <= s.endCol;
    return true;
  }

  /** Extract selected text from the FULL content lines (0-indexed). */
  getSelectedText(allContentLines: string[]): string {
    if (!this.selection) return "";
    const s = this.normalize(this.selection);

    const lines: string[] = [];
    for (let row = s.startRow; row <= s.endRow; row++) {
      const line = stripAnsi(allContentLines[row - 1] ?? "");
      if (row === s.startRow && row === s.endRow) {
        lines.push(line.slice(s.startCol - 1, s.endCol));
      } else if (row === s.startRow) {
        lines.push(line.slice(s.startCol - 1));
      } else if (row === s.endRow) {
        lines.push(line.slice(0, s.endCol));
      } else {
        lines.push(line);
      }
    }
    return lines.join("\n");
  }

  /** Copy text to system clipboard via OSC 52 escape sequence. */
  copyToClipboard(terminal: Terminal, text: string): void {
    if (!text) return;
    const b64 = Buffer.from(text).toString("base64");
    terminal.write(`\x1b]52;c;${b64}\x07`);
  }

  /** Select the word at screen position (1-based row/col). */
  selectWordAt(screenRow: number, col: number, screenLines: string[]): void {
    const line = stripAnsi(screenLines[screenRow - 1] ?? "");
    if (!line || col < 1 || col > line.length) {
      this.selectLine(screenRow, screenLines);
      return;
    }
    const contentRow = this.screenToContent(screenRow);
    const idx = col - 1;
    const wordChar = /[\w\-\.@\/]/;
    let start = idx;
    while (start > 0 && wordChar.test(line[start - 1]!)) start--;
    let end = idx;
    while (end < line.length - 1 && wordChar.test(line[end + 1]!)) end++;
    this.selection = { startRow: contentRow, startCol: start + 1, endRow: contentRow, endCol: end + 1 };
    this.selecting = false;
  }

  /** Select an entire line at screen position (1-based row). */
  selectLine(screenRow: number, screenLines: string[]): void {
    const line = stripAnsi(screenLines[screenRow - 1] ?? "");
    const contentRow = this.screenToContent(screenRow);
    this.selection = { startRow: contentRow, startCol: 1, endRow: contentRow, endCol: Math.max(1, line.length) };
    this.selecting = false;
  }

  private normalize(s: Selection): Selection {
    if (s.startRow > s.endRow || (s.startRow === s.endRow && s.startCol > s.endCol)) {
      return { startRow: s.endRow, startCol: s.endCol, endRow: s.startRow, endCol: s.startCol };
    }
    return s;
  }
}
