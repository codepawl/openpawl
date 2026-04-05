/**
 * Multi-line text editor component.
 * Features: cursor movement, history, autocomplete trigger, paste handling.
 */
import type { Component } from "../core/component.js";
import type { KeyEvent } from "../core/input.js";
import { visibleWidth } from "../utils/text-width.js";
import { truncate } from "../utils/truncate.js";
import { defaultTheme } from "../themes/default.js";

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

  private lines: string[] = [""];
  private cursorRow = 0;
  private cursorCol = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private placeholder: string;
  private borderColor: (s: string) => string;
  private focused = false;

  // Autocomplete state
  private acSuggestions: AutocompleteSuggestion[] = [];
  private acSelectedIndex = 0;
  private acActive = false;
  private acMaxVisible = 8;

  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  autocompleteProvider?: AutocompleteProvider;

  constructor(id: string, placeholder = "Type a message...") {
    this.id = id;
    this.placeholder = placeholder;
    this.borderColor = defaultTheme.dim;
  }

  render(width: number): string[] {
    const result: string[] = [];
    const innerWidth = width - 4; // borders + padding

    // Autocomplete popup (rendered above editor box)
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

    // Top border
    const border = this.focused ? this.borderColor : defaultTheme.dim;
    result.push(border("┌" + "─".repeat(width - 2) + "┐"));

    // Content lines or placeholder
    const isEmpty = this.lines.length === 1 && this.lines[0] === "";
    if (isEmpty && !this.focused) {
      const truncatedPlaceholder = truncate(this.placeholder, innerWidth, "");
      const placeholderPad = Math.max(0, innerWidth - visibleWidth(truncatedPlaceholder));
      result.push(border("│") + " " + defaultTheme.dim(truncatedPlaceholder) + " ".repeat(placeholderPad) + " " + border("│"));
    } else {
      for (const line of this.lines) {
        const display = truncate(line, innerWidth, "");
        const padding = Math.max(0, innerWidth - visibleWidth(display));
        result.push(border("│") + " " + display + " ".repeat(padding) + " " + border("│"));
      }
    }

    // Bottom border
    result.push(border("└" + "─".repeat(width - 2) + "┘"));

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
        // Enter: select highlighted item AND submit
        const selected = this.acSuggestions[this.acSelectedIndex];
        if (selected) {
          const text = selected.insertText.trim();
          this.dismissAutocomplete();
          this.pushHistory(text);
          this.onSubmit?.(text);
          this.clear();
        } else {
          this.dismissAutocomplete();
        }
        return true;
      }
      if (event.type === "tab") {
        // Tab: fill in suggestion, stay in editor (user can add args)
        const selected = this.acSuggestions[this.acSelectedIndex];
        if (selected) {
          this.setText(selected.insertText);
          this.cursorCol = selected.insertText.length;
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

    // Enter → submit (unless shift held for newline)
    if (event.type === "enter") {
      const text = this.getText();
      if (text.trim()) {
        this.pushHistory(text);
        this.onSubmit?.(text);
        this.clear();
      }
      return true;
    }

    // Backspace
    if (event.type === "backspace") {
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

    // Arrow keys
    if (event.type === "arrow") {
      if (event.direction === "left") {
        if (this.cursorCol > 0) this.cursorCol--;
        return true;
      }
      if (event.direction === "right") {
        if (this.cursorCol < (this.lines[this.cursorRow]?.length ?? 0)) this.cursorCol++;
        return true;
      }
      if (event.direction === "up") {
        // History navigation
        if (this.cursorRow === 0 && this.history.length > 0) {
          if (this.historyIndex === -1) this.historyIndex = this.history.length;
          if (this.historyIndex > 0) {
            this.historyIndex--;
            this.setText(this.history[this.historyIndex]!);
          }
          return true;
        }
        if (this.cursorRow > 0) {
          this.cursorRow--;
          this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorRow]?.length ?? 0);
        }
        return true;
      }
      if (event.direction === "down") {
        if (this.historyIndex >= 0) {
          this.historyIndex++;
          if (this.historyIndex >= this.history.length) {
            this.historyIndex = -1;
            this.clear();
          } else {
            this.setText(this.history[this.historyIndex]!);
          }
          return true;
        }
        if (this.cursorRow < this.lines.length - 1) {
          this.cursorRow++;
          this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorRow]?.length ?? 0);
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

    // Ctrl+A — select all / go to start
    if (event.type === "char" && event.ctrl && event.char === "a") {
      this.cursorRow = 0;
      this.cursorCol = 0;
      return true;
    }

    // Ctrl+E — go to end
    if (event.type === "char" && event.ctrl && event.char === "e") {
      this.cursorRow = this.lines.length - 1;
      this.cursorCol = this.lines[this.cursorRow]?.length ?? 0;
      return true;
    }

    // Ctrl+U — clear line
    if (event.type === "char" && event.ctrl && event.char === "u") {
      this.lines[this.cursorRow] = "";
      this.cursorCol = 0;
      this.onChange?.(this.getText());
      return true;
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

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.autocompleteProvider = provider;
  }

  /** Set cursor column from a click position (1-based terminal column). */
  /** Check if autocomplete popup is currently visible. */
  isAutocompleteActive(): boolean {
    return this.acActive && this.acSuggestions.length > 0;
  }

  setCursorFromClick(termCol: number): void {
    const contentCol = Math.max(0, termCol - 3);
    const lineLen = this.lines[this.cursorRow]?.length ?? 0;
    this.cursorCol = Math.min(contentCol, lineLen);
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

  /** Move cursor to end (triple-click selects all conceptually). */
  selectAllText(): void {
    this.cursorRow = this.lines.length - 1;
    this.cursorCol = this.lines[this.cursorRow]?.length ?? 0;
  }

  getCursorPosition(): { row: number; col: number } | null {
    if (!this.focused) return null;
    // Calculate how many autocomplete lines are above the editor box
    const acLines = this.getAutocompleteLineCount();
    // row: acLines + 1 for top border + cursorRow (1-based)
    // col: 2 for "│ " border+padding + cursorCol (1-based)
    return {
      row: acLines + 1 + this.cursorRow + 1,
      col: this.cursorCol + 3,
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
}
