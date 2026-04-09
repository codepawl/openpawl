/**
 * Multi-line text editor component.
 * Features: cursor movement, history, autocomplete trigger, paste handling.
 */
import type { Component } from "../core/component.js";
import type { KeyEvent } from "../core/input.js";
import type { LayoutConfig } from "../layout/responsive.js";
import { visibleWidth, charWidth } from "../utils/text-width.js";
import { truncate } from "../utils/truncate.js";
import { TextWrapper, type WrappedLine } from "../text/text-wrapper.js";
import { defaultTheme, ctp } from "../themes/default.js";

export interface AutocompleteProvider {
  getSuggestions(input: string, cursorPos: number): AutocompleteSuggestion[];
}

export interface AutocompleteSuggestion {
  label: string;
  description?: string;
  insertText: string;
}

export class EditorComponent implements Component {
  readonly id: string;
  readonly focusable = true;
  hidden = false;

  private lines: string[] = [""];
  private cursorRow = 0;
  private cursorCol = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private placeholder: string;
  private borderColor: (s: string) => string;
  private focused = false;
  /** When true, arrow keys don't trigger history navigation (e.g. interactive view is active). */
  suppressHistory = false;

  // Responsive layout
  private layoutProvider?: () => LayoutConfig;

  // Multiline scroll state
  private maxVisibleLines = 8;
  private inputScrollOffset = 0;

  // Autocomplete state
  private acSuggestions: AutocompleteSuggestion[] = [];
  private acSelectedIndex = 0;
  private acActive = false;
  private acMaxVisible = 8;

  // Text selection state (for Ctrl+A select all, type-to-replace)
  private selStart: { row: number; col: number } | null = null;
  private selEnd: { row: number; col: number } | null = null;

  // Visual line wrapping cache (rebuilt each render)
  private cachedVisualLines: WrappedLine[] = [];

  // Attached files (from @file mentions)
  private attachedFiles: string[] = [];

  onSubmit?: (text: string, attachedFiles?: string[]) => void;
  onChange?: (text: string) => void;
  autocompleteProvider?: AutocompleteProvider;

  constructor(id: string, placeholder = "Ask anything...") {
    this.id = id;
    this.placeholder = placeholder;
    this.borderColor = ctp.surface0;
  }

  render(width: number): string[] {
    // Update max visible lines from responsive layout
    this.maxVisibleLines = this.layoutProvider?.().maxInputLines ?? 8;

    const result: string[] = [];

    // Autocomplete popup (rendered above editor)
    if (this.acActive && this.acSuggestions.length > 0) {
      const start = Math.max(0, this.acSelectedIndex - this.acMaxVisible + 1);
      const end = Math.min(this.acSuggestions.length, start + this.acMaxVisible);
      const visible = this.acSuggestions.slice(start, end);

      if (start > 0) {
        result.push(defaultTheme.dim("  ↑ " + start + " more"));
      }
      for (let i = 0; i < visible.length; i++) {
        const item = visible[i]!;
        const globalIdx = start + i;
        const isSelected = globalIdx === this.acSelectedIndex;
        const prefix = isSelected ? defaultTheme.primary("❯ ") : "  ";
        let line = prefix + (isSelected ? defaultTheme.bold(item.label) : item.label);
        if (item.description) {
          line += "  " + defaultTheme.dim(item.description);
        }
        result.push(line);
      }
      if (end < this.acSuggestions.length) {
        result.push(defaultTheme.dim("  ↓ " + (this.acSuggestions.length - end) + " more"));
      }
    }

    // Borderless layout: "─" separator + prompt lines (no box)
    const promptSymbol = ctp.mauve("❯");
    const promptWidth = 2; // "❯ " = 2 visible chars
    const contentWidth = width - promptWidth - 1; // 1 char left margin
    const fileTags = this.attachedFiles.length > 0
      ? this.attachedFiles.map((f) => ctp.blue(`[@${f.split("/").pop()}]`)).join(" ") + " "
      : "";
    const fileTagsWidth = this.attachedFiles.length > 0 ? visibleWidth(fileTags) : 0;
    const textContentWidth = Math.max(1, contentWidth - fileTagsWidth);

    // Build visual line map (wraps long logical lines) and adjust scroll
    this.cachedVisualLines = this.buildVisualLineMap(textContentWidth, contentWidth);
    this.adjustInputScroll();

    const isEmpty = this.lines.length === 1 && this.lines[0] === "";
    const totalVisual = this.cachedVisualLines.length;
    const visibleCount = Math.min(totalVisual, this.maxVisibleLines);
    const hasBelow = this.inputScrollOffset + visibleCount < totalVisual;

    // Scroll indicator (shown on divider line above, if scrolled)
    // No separator line — the DividerComponent above handles it.

    // Content lines
    if (isEmpty && !this.focused && this.attachedFiles.length === 0) {
      const truncatedPlaceholder = truncate(this.placeholder, contentWidth, "");
      result.push(" " + promptSymbol + " " + ctp.overlay0(truncatedPlaceholder));
    } else {
      const startVis = this.inputScrollOffset;
      const endVis = Math.min(totalVisual, startVis + this.maxVisibleLines);
      for (let v = startVis; v < endVis; v++) {
        const wl = this.cachedVisualLines[v]!;
        const isPromptLine = v === 0;
        const prefix = isPromptLine ? promptSymbol + " " + fileTags : "  ";
        const availWidth = isPromptLine ? textContentWidth : contentWidth;
        const rawDisplay = truncate(wl.content, availWidth, "");
        const display = this.hasSelection() ? this.highlightSelection(rawDisplay, wl) : rawDisplay;
        result.push(" " + prefix + display);
      }
    }

    // Scroll-down indicator
    if (hasBelow) {
      const belowCount = totalVisual - this.inputScrollOffset - visibleCount;
      result.push(ctp.overlay0(`  ▼ ${belowCount} more`));
    }

    return result;
  }

  onKey(event: KeyEvent): boolean {
    // Autocomplete navigation (when popup is active)
    if (this.acActive) {
      if (event.type === "arrow" && event.direction === "up") {
        this.acSelectedIndex = Math.max(0, this.acSelectedIndex - 1);
        return true;
      }
      if (event.type === "arrow" && event.direction === "down") {
        this.acSelectedIndex = Math.min(this.acSuggestions.length - 1, this.acSelectedIndex + 1);
        return true;
      }
      if (event.type === "enter") {
        const selected = this.acSuggestions[this.acSelectedIndex];
        if (selected) {
          const insertText = selected.insertText.trim();
          // @file references → attach as file tag, don't submit
          if (insertText.startsWith("@") && !this.isAgentMention(insertText)) {
            const filePath = insertText.slice(1); // remove @ prefix
            this.attachFile(filePath);
            this.dismissAutocomplete();
          } else {
            // Commands and agent mentions → submit immediately
            this.dismissAutocomplete();
            this.pushHistory(insertText);
            this.onSubmit?.(insertText, this.attachedFiles.length > 0 ? [...this.attachedFiles] : undefined);
            this.clear();
            this.attachedFiles = [];
          }
        } else {
          this.dismissAutocomplete();
        }
        return true;
      }
      if (event.type === "tab") {
        // Tab: for @file → attach file; for commands → fill suggestion
        const selected = this.acSuggestions[this.acSelectedIndex];
        if (selected) {
          const insertText = selected.insertText.trim();
          if (insertText.startsWith("@") && !this.isAgentMention(insertText)) {
            this.attachFile(insertText.slice(1));
          } else {
            this.setText(selected.insertText);
            this.cursorCol = selected.insertText.length;
          }
        }
        this.dismissAutocomplete();
        return true;
      }
      if (event.type === "escape") {
        this.dismissAutocomplete();
        return true;
      }
      // Other keys: dismiss autocomplete and fall through to normal handling
      this.dismissAutocomplete();
    }

    // Selection handling: typing replaces selection, arrows/escape clear it
    if (this.hasSelection()) {
      // Typing a character replaces the selection
      if (event.type === "char" && !event.ctrl && !event.alt) {
        this.deleteSelection();
        // Fall through to normal char insertion below
      } else if (event.type === "backspace" || event.type === "delete") {
        this.deleteSelection();
        this.onChange?.(this.getText());
        return true;
      } else if (event.type === "enter" && !event.shift) {
        this.deleteSelection();
        // Fall through to submit
      } else if (event.type === "arrow" || event.type === "escape" || event.type === "home" || event.type === "end") {
        this.clearSelection();
        // Fall through to normal handling
      }
    }

    // Shift+Enter → insert newline
    if (event.type === "enter" && event.shift) {
      this.insertNewline();
      this.onChange?.(this.getText());
      return true;
    }

    // Enter → submit with attached files
    if (event.type === "enter" && !event.shift) {
      const text = this.getText();
      if (text.trim() || this.attachedFiles.length > 0) {
        this.pushHistory(text);
        this.onSubmit?.(text, this.attachedFiles.length > 0 ? [...this.attachedFiles] : undefined);
        this.clear();
        this.attachedFiles = [];
      }
      return true;
    }

    // Backspace — remove file tag when at start of empty line
    if (event.type === "backspace") {
      if (this.cursorCol === 0 && this.cursorRow === 0 && this.attachedFiles.length > 0) {
        this.attachedFiles.pop();
        this.onChange?.(this.getText());
        return true;
      }
      if (this.cursorCol > 0) {
        const line = this.lines[this.cursorRow]!;
        this.lines[this.cursorRow] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
        this.cursorCol--;
      } else if (this.cursorRow > 0) {
        // Merge with previous line
        const prevLine = this.lines[this.cursorRow - 1]!;
        this.cursorCol = prevLine.length;
        this.lines[this.cursorRow - 1] = prevLine + this.lines[this.cursorRow];
        this.lines.splice(this.cursorRow, 1);
        this.cursorRow--;
      }
      this.onChange?.(this.getText());
      this.triggerAutocomplete();
      return true;
    }

    // Arrow keys — with Ctrl for word navigation
    if (event.type === "arrow") {
      if (event.direction === "left") {
        if (event.ctrl) {
          // Ctrl+Left: jump to start of previous word
          this.cursorCol = jumpWordLeft(this.lines[this.cursorRow] ?? "", this.cursorCol);
        } else {
          if (this.cursorCol > 0) this.cursorCol--;
        }
        return true;
      }
      if (event.direction === "right") {
        if (event.ctrl) {
          // Ctrl+Right: jump to start of next word
          this.cursorCol = jumpWordRight(this.lines[this.cursorRow] ?? "", this.cursorCol);
        } else {
          if (this.cursorCol < (this.lines[this.cursorRow]?.length ?? 0)) this.cursorCol++;
        }
        return true;
      }
      if (event.direction === "up") {
        const curVis = this.cachedVisualLines.length > 0
          ? this.logicalToVisual(this.cachedVisualLines, this.cursorRow, this.cursorCol).visualRow
          : 0;
        // History navigation: Alt+Up always, or plain Up when on first visual line
        if (!this.suppressHistory && this.history.length > 0 && (event.alt || curVis === 0)) {
          if (this.historyIndex === -1) this.historyIndex = this.history.length;
          if (this.historyIndex > 0) {
            this.historyIndex--;
            this.setText(this.history[this.historyIndex]!);
          }
          return true;
        }
        // Visual line cursor movement
        if (!event.alt && curVis > 0 && this.cachedVisualLines.length > 0) {
          const { visualCol } = this.logicalToVisual(this.cachedVisualLines, this.cursorRow, this.cursorCol);
          const { logicalRow, startOffset } = this.visualToLogical(this.cachedVisualLines, curVis - 1);
          const prevLineSegmentLen = this.cachedVisualLines[curVis - 1]!.originalEndOffset - startOffset;
          this.cursorRow = logicalRow;
          this.cursorCol = Math.min(startOffset + visualCol, startOffset + prevLineSegmentLen);
        }
        return true;
      }
      if (event.direction === "down") {
        const curVis = this.cachedVisualLines.length > 0
          ? this.logicalToVisual(this.cachedVisualLines, this.cursorRow, this.cursorCol).visualRow
          : 0;
        const lastVis = Math.max(0, this.cachedVisualLines.length - 1);
        // History navigation: Alt+Down always, or plain Down when on last visual line
        if (!this.suppressHistory && this.historyIndex >= 0 && (event.alt || curVis >= lastVis)) {
          this.historyIndex++;
          if (this.historyIndex >= this.history.length) {
            this.historyIndex = -1;
            this.clear();
          } else {
            this.setText(this.history[this.historyIndex]!);
          }
          return true;
        }
        // Visual line cursor movement
        if (!event.alt && curVis < lastVis && this.cachedVisualLines.length > 0) {
          const { visualCol } = this.logicalToVisual(this.cachedVisualLines, this.cursorRow, this.cursorCol);
          const { logicalRow, startOffset } = this.visualToLogical(this.cachedVisualLines, curVis + 1);
          const nextLineSegmentLen = this.cachedVisualLines[curVis + 1]!.originalEndOffset - startOffset;
          this.cursorRow = logicalRow;
          this.cursorCol = Math.min(startOffset + visualCol, startOffset + nextLineSegmentLen);
        }
        return true;
      }
    }

    // Home/End
    if (event.type === "home") { this.cursorCol = 0; return true; }
    if (event.type === "end") { this.cursorCol = this.lines[this.cursorRow]?.length ?? 0; return true; }

    // Delete
    if (event.type === "delete") {
      const line = this.lines[this.cursorRow]!;
      if (this.cursorCol < line.length) {
        this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
        this.onChange?.(this.getText());
      }
      return true;
    }

    // Ctrl+A — select all text
    if (event.type === "char" && event.ctrl && event.char === "a") {
      this.selectAllText();
      return true;
    }

    // Ctrl+E — go to end
    if (event.type === "char" && event.ctrl && event.char === "e") {
      this.cursorRow = this.lines.length - 1;
      this.cursorCol = this.lines[this.cursorRow]?.length ?? 0;
      return true;
    }

    // Ctrl+U — delete from cursor to start of line
    if (event.type === "char" && event.ctrl && event.char === "u") {
      const line = this.lines[this.cursorRow] ?? "";
      this.lines[this.cursorRow] = line.slice(this.cursorCol);
      this.cursorCol = 0;
      this.onChange?.(this.getText());
      return true;
    }

    // Ctrl+K — delete from cursor to end of line
    if (event.type === "char" && event.ctrl && event.char === "k") {
      const line = this.lines[this.cursorRow] ?? "";
      this.lines[this.cursorRow] = line.slice(0, this.cursorCol);
      this.onChange?.(this.getText());
      return true;
    }

    // Ctrl+W — delete previous word
    if (event.type === "char" && event.ctrl && event.char === "w") {
      const line = this.lines[this.cursorRow] ?? "";
      const newCol = jumpWordLeft(line, this.cursorCol);
      this.lines[this.cursorRow] = line.slice(0, newCol) + line.slice(this.cursorCol);
      this.cursorCol = newCol;
      this.onChange?.(this.getText());
      return true;
    }

    // Escape — clear editor text (Ctrl+C no longer clears input)
    if (event.type === "escape") {
      if (this.getText().trim().length > 0) {
        this.clear();
        this.onChange?.(this.getText());
        return true;
      }
      return false;
    }

    // Paste
    if (event.type === "paste") {
      this.insertText(event.text);
      this.onChange?.(this.getText());
      return true;
    }

    // Regular character
    if (event.type === "char" && !event.ctrl && !event.alt) {
      this.insertChar(event.char);
      this.onChange?.(this.getText());
      this.triggerAutocomplete();
      return true;
    }

    return false;
  }

  onFocus(): void {
    this.focused = true;
  }

  onBlur(): void {
    this.focused = false;
  }

  getText(): string {
    return this.lines.join("\n");
  }

  setText(text: string): void {
    this.lines = text.split("\n");
    this.cursorRow = this.lines.length - 1;
    this.cursorCol = this.lines[this.cursorRow]?.length ?? 0;
  }

  clear(): void {
    this.lines = [""];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.historyIndex = -1;
  }

  pushHistory(entry: string): void {
    if (entry.trim() && this.history[this.history.length - 1] !== entry) {
      this.history.push(entry);
    }
    this.historyIndex = -1;
  }

  setBorderColor(colorFn: (s: string) => string): void {
    this.borderColor = colorFn;
  }

  setPlaceholder(text: string): void {
    this.placeholder = text;
  }

  setLayoutProvider(fn: () => LayoutConfig): void {
    this.layoutProvider = fn;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.autocompleteProvider = provider;
  }

  /** Scroll input content by delta visual lines. Returns true if consumed. */
  scrollInput(delta: number): boolean {
    const totalVisual = this.cachedVisualLines.length;
    if (totalVisual <= this.maxVisibleLines) return false;
    const newOffset = Math.max(0, Math.min(this.inputScrollOffset + delta, totalVisual - this.maxVisibleLines));
    if (newOffset === this.inputScrollOffset) return false;
    this.inputScrollOffset = newOffset;
    return true;
  }

  /** Check if autocomplete popup is currently visible. */
  isAutocompleteActive(): boolean {
    return this.acActive && this.acSuggestions.length > 0;
  }

  setCursorFromClick(relativeRow: number, termCol: number): void {
    this.clearSelection();
    const acLines = this.getAutocompleteLineCount();
    const visualRow = relativeRow - acLines + this.inputScrollOffset;
    const wl = this.cachedVisualLines[visualRow];
    if (!wl) {
      // Fallback: just set column on current line
      const contentCol = Math.max(0, termCol - 4);
      const lineLen = this.lines[this.cursorRow]?.length ?? 0;
      this.cursorCol = Math.min(contentCol, lineLen);
      return;
    }
    const isFirstVisualLine = visualRow === 0;
    const fileTagsWidth = isFirstVisualLine && this.attachedFiles.length > 0
      ? this.attachedFiles.reduce((w, f) => w + f.split("/").pop()!.length + 3, 0) + 1
      : 0;
    // Layout: margin(1) + prompt/indent(2) + fileTags
    const prefixWidth = 3 + (isFirstVisualLine ? fileTagsWidth : 0);
    const col = Math.max(0, termCol - prefixWidth - 1);
    // Clamp to visual line content length to prevent cursor past actual text
    const visualContentLen = wl.originalEndOffset - wl.originalStartOffset;
    const clampedCol = Math.min(col, visualContentLen);
    this.cursorRow = wl.originalLineIndex;
    this.cursorCol = Math.min(wl.originalStartOffset + clampedCol, this.lines[this.cursorRow]?.length ?? 0);
  }

  /** Select the word at cursor (double-click). */
  selectWordAtCursor(): void {
    const line = this.lines[this.cursorRow] ?? "";
    const pos = this.cursorCol;
    const wordChar = /[\w\-\.@\/]/;
    let end = pos;
    while (end < line.length && wordChar.test(line[end]!)) end++;
    this.cursorCol = end;
  }

  /** Select all text in the editor (Ctrl+A). */
  selectAllText(): void {
    this.selStart = { row: 0, col: 0 };
    const lastRow = this.lines.length - 1;
    this.selEnd = { row: lastRow, col: this.lines[lastRow]?.length ?? 0 };
    this.cursorRow = lastRow;
    this.cursorCol = this.lines[lastRow]?.length ?? 0;
  }

  /** Check if there's an active text selection. */
  hasSelection(): boolean {
    return this.selStart !== null && this.selEnd !== null;
  }

  /** Get the selected text, or null if no selection. */
  getSelectedText(): string | null {
    if (!this.selStart || !this.selEnd) return null;
    const [s, e] = this.normalizeSelection();
    if (s.row === e.row) {
      return (this.lines[s.row] ?? "").slice(s.col, e.col);
    }
    const parts: string[] = [];
    parts.push((this.lines[s.row] ?? "").slice(s.col));
    for (let r = s.row + 1; r < e.row; r++) parts.push(this.lines[r] ?? "");
    parts.push((this.lines[e.row] ?? "").slice(0, e.col));
    return parts.join("\n");
  }

  /** Delete the selected text and position cursor at selection start. */
  private deleteSelection(): void {
    if (!this.selStart || !this.selEnd) return;
    const [s, e] = this.normalizeSelection();
    const before = (this.lines[s.row] ?? "").slice(0, s.col);
    const after = (this.lines[e.row] ?? "").slice(e.col);
    this.lines.splice(s.row, e.row - s.row + 1, before + after);
    if (this.lines.length === 0) this.lines = [""];
    this.cursorRow = s.row;
    this.cursorCol = s.col;
    this.clearSelection();
  }

  /** Clear selection state. */
  clearSelection(): void {
    this.selStart = null;
    this.selEnd = null;
  }

  /** Normalize selection so start <= end. */
  private normalizeSelection(): [{ row: number; col: number }, { row: number; col: number }] {
    const a = this.selStart!;
    const b = this.selEnd!;
    if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b];
    return [b, a];
  }

  /** Check if a cell is within the selection (for rendering). */
  private isCellSelected(row: number, col: number): boolean {
    if (!this.selStart || !this.selEnd) return false;
    const [s, e] = this.normalizeSelection();
    if (row < s.row || row > e.row) return false;
    if (row === s.row && row === e.row) return col >= s.col && col < e.col;
    if (row === s.row) return col >= s.col;
    if (row === e.row) return col < e.col;
    return true; // middle row
  }

  /** Apply reverse-video highlighting to selected characters in a visual line.
   *  Iterates by code point to avoid splitting surrogate pairs (emoji, CJK). */
  private highlightSelection(display: string, wl: WrappedLine): string {
    if (!this.hasSelection()) return display;
    let result = "";
    let logicalCol = 0;
    let i = 0;
    while (i < display.length) {
      const cp = display.codePointAt(i)!;
      const charLen = cp > 0xffff ? 2 : 1;
      const char = display.slice(i, i + charLen);

      if (this.isCellSelected(wl.originalLineIndex, wl.originalStartOffset + logicalCol)) {
        result += `\x1b[7m${char}\x1b[27m`;
      } else {
        result += char;
      }

      logicalCol += charWidth(cp) || 1;
      i += charLen;
    }
    return result;
  }

  getCursorPosition(): { row: number; col: number } | null {
    if (!this.focused || this.cachedVisualLines.length === 0) return null;
    const { visualRow, visualCol } = this.logicalToVisual(
      this.cachedVisualLines, this.cursorRow, this.cursorCol,
    );
    const visibleRow = visualRow - this.inputScrollOffset;
    if (visibleRow < 0 || visibleRow >= Math.min(this.cachedVisualLines.length, this.maxVisibleLines)) {
      return null; // cursor not in visible area
    }
    const acLines = this.getAutocompleteLineCount();
    // File tags width only applies on the very first visual line (prompt row)
    const fileTagsWidth = visualRow === 0 && this.attachedFiles.length > 0
      ? this.attachedFiles.reduce((w, f) => w + f.split("/").pop()!.length + 3, 0) + 1
      : 0;
    // Layout: margin(1) + prompt/indent(2) + fileTags + visualCol
    return {
      row: acLines + visibleRow + 1, // +1 for 1-based (no separator line)
      col: visualCol + 4 + fileTagsWidth, // margin(1) + prompt(2) + space after prompt is in prefix
    };
  }

  private getAutocompleteLineCount(): number {
    if (!this.acActive || this.acSuggestions.length === 0) return 0;
    const start = Math.max(0, this.acSelectedIndex - this.acMaxVisible + 1);
    const end = Math.min(this.acSuggestions.length, start + this.acMaxVisible);
    let count = end - start;
    if (start > 0) count++; // "↑ N more"
    if (end < this.acSuggestions.length) count++; // "↓ N more"
    return count;
  }

  private triggerAutocomplete(): void {
    if (!this.autocompleteProvider) return;
    const text = this.getText();
    const cursorPos = this.cursorCol;
    if (text.startsWith("/") || text.includes("@")) {
      const suggestions = this.autocompleteProvider.getSuggestions(text, cursorPos);
      if (suggestions.length > 0) {
        this.acSuggestions = suggestions;
        this.acSelectedIndex = 0;
        this.acActive = true;
        return;
      }
    }
    this.dismissAutocomplete();
  }

  /** Dismiss the autocomplete popup. */
  dismissAutocomplete(): void {
    this.acActive = false;
    this.acSuggestions = [];
    this.acSelectedIndex = 0;
  }

  private insertChar(char: string): void {
    const line = this.lines[this.cursorRow]!;
    this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + char + line.slice(this.cursorCol);
    this.cursorCol += char.length;
  }

  /** Build a flat array of visual (wrapped) lines from all logical lines. */
  private buildVisualLineMap(firstLineWidth: number, otherLinesWidth: number): WrappedLine[] {
    const result: WrappedLine[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      const width = i === 0 ? firstLineWidth : otherLinesWidth;
      const wrapper = new TextWrapper(width);
      const wrapped = wrapper.wrap(this.lines[i]!, { breakLongWords: true });
      for (const wl of wrapped.lines) {
        result.push({
          content: wl.content,
          isWrapped: wl.isWrapped,
          originalLineIndex: i,
          originalStartOffset: wl.originalStartOffset,
          originalEndOffset: wl.originalEndOffset,
        });
      }
    }
    return result;
  }

  /** Map logical (cursorRow, cursorCol) to visual line coordinates. */
  private logicalToVisual(
    visualLines: WrappedLine[],
    logicalRow: number,
    logicalCol: number,
  ): { visualRow: number; visualCol: number } {
    for (let v = 0; v < visualLines.length; v++) {
      const wl = visualLines[v]!;
      if (wl.originalLineIndex !== logicalRow) continue;
      if (logicalCol >= wl.originalStartOffset && logicalCol <= wl.originalEndOffset) {
        // If col is at the end boundary and there's a next visual line for the same logical line,
        // place cursor at start of next visual line (unless this is the last segment)
        if (logicalCol === wl.originalEndOffset && v + 1 < visualLines.length &&
            visualLines[v + 1]!.originalLineIndex === logicalRow) {
          return { visualRow: v + 1, visualCol: 0 };
        }
        return { visualRow: v, visualCol: logicalCol - wl.originalStartOffset };
      }
    }
    // Fallback: last visual line
    return { visualRow: Math.max(0, visualLines.length - 1), visualCol: logicalCol };
  }

  /** Map visual line coordinates back to logical (cursorRow, cursorCol). */
  private visualToLogical(
    visualLines: WrappedLine[],
    visualRow: number,
  ): { logicalRow: number; startOffset: number } {
    const clamped = Math.max(0, Math.min(visualRow, visualLines.length - 1));
    const wl = visualLines[clamped];
    if (!wl) return { logicalRow: 0, startOffset: 0 };
    return { logicalRow: wl.originalLineIndex, startOffset: wl.originalStartOffset };
  }

  private adjustInputScroll(): void {
    const totalVisual = this.cachedVisualLines.length;
    if (totalVisual <= this.maxVisibleLines) {
      this.inputScrollOffset = 0;
      return;
    }
    const { visualRow } = this.logicalToVisual(this.cachedVisualLines, this.cursorRow, this.cursorCol);
    if (visualRow < this.inputScrollOffset) {
      this.inputScrollOffset = visualRow;
    }
    if (visualRow >= this.inputScrollOffset + this.maxVisibleLines) {
      this.inputScrollOffset = visualRow - this.maxVisibleLines + 1;
    }
  }

  private insertNewline(): void {
    const line = this.lines[this.cursorRow]!;
    const before = line.slice(0, this.cursorCol);
    const after = line.slice(this.cursorCol);
    this.lines[this.cursorRow] = before;
    this.lines.splice(this.cursorRow + 1, 0, after);
    this.cursorRow++;
    this.cursorCol = 0;
  }

  private insertText(text: string): void {
    const textLines = text.split("\n");
    if (textLines.length === 1) {
      this.insertChar(textLines[0]!);
      return;
    }
    // Multi-line paste
    const currentLine = this.lines[this.cursorRow]!;
    const before = currentLine.slice(0, this.cursorCol);
    const after = currentLine.slice(this.cursorCol);

    this.lines[this.cursorRow] = before + textLines[0]!;
    for (let i = 1; i < textLines.length - 1; i++) {
      this.lines.splice(this.cursorRow + i, 0, textLines[i]!);
    }
    const lastPasteLine = textLines[textLines.length - 1]!;
    this.lines.splice(this.cursorRow + textLines.length - 1, 0, lastPasteLine + after);

    this.cursorRow += textLines.length - 1;
    this.cursorCol = lastPasteLine.length;
  }

  // ── File attachment ─────────────────────────────────────

  /** Attach a file reference (from @file autocomplete). */
  private attachFile(filePath: string): void {
    if (!this.attachedFiles.includes(filePath)) {
      this.attachedFiles.push(filePath);
    }
    // Remove the @partial from the current line
    const line = this.lines[this.cursorRow] ?? "";
    const atIdx = line.lastIndexOf("@");
    if (atIdx >= 0) {
      this.lines[this.cursorRow] = line.slice(0, atIdx) + line.slice(this.cursorCol);
      this.cursorCol = atIdx;
    }
  }

  /** Check if an autocomplete suggestion is an @agent mention (not a file). */
  private isAgentMention(text: string): boolean {
    const agents = ["coder", "reviewer", "planner", "tester", "debugger", "researcher", "assistant"];
    const name = text.replace(/^@/, "").toLowerCase();
    return agents.includes(name);
  }

  /** Get currently attached files. */
  getAttachedFiles(): string[] {
    return [...this.attachedFiles];
  }

  /** Remove the last attached file (Backspace on empty line with files). */
  removeLastAttachedFile(): boolean {
    if (this.attachedFiles.length > 0 && this.getText().trim() === "" && this.cursorCol === 0) {
      this.attachedFiles.pop();
      return true;
    }
    return false;
  }
}

// ── Word navigation helpers ──────────────────────────────

/** Jump cursor to start of previous word. */
function jumpWordLeft(text: string, cursor: number): number {
  if (cursor === 0) return 0;
  let i = cursor - 1;
  while (i > 0 && text[i - 1] === " ") i--;
  while (i > 0 && text[i - 1] !== " ") i--;
  return i;
}

/** Jump cursor to start of next word. */
function jumpWordRight(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  let i = cursor;
  while (i < text.length && text[i] !== " ") i++;
  while (i < text.length && text[i] === " ") i++;
  return i;
}
