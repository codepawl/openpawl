/**
 * Base class for interactive TUI views.
 * Handles ↑/↓ navigation, Esc/Ctrl+C to close,
 * and key handler stack management.
 * Subclasses implement getItemCount(), handleCustomKey(), and renderLines().
 *
 * Opt-in filter: set `filterEnabled = true` in subclass. Typing characters
 * populates `filterText`. Subclass should use `matchesFilter(label)` to
 * filter items in `renderLines()` and `getItemCount()`.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { defaultTheme } from "../../tui/themes/default.js";
import { visibleWidth } from "../../tui/utils/text-width.js";
import { renderPanel } from "../../tui/components/panel.js";

export abstract class InteractiveView {
  protected selectedIndex = 0;
  protected active = false;
  protected filterEnabled = false;
  protected filterText = "";

  constructor(
    protected tui: TUI,
    protected onClose: () => void,
  ) {}

  activate(): void {
    this.active = true;
    this.selectedIndex = 0;
    this.tui.pushKeyHandler(this);
    this.render();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.tui.popKeyHandler();
    this.tui.clearInteractiveView();
    this.onClose();
  }

  handleKey(event: KeyEvent): boolean {
    if (!this.active) return false;

    // Ctrl+C: cancel edit if editing, close view if navigating
    if (event.type === "char" && event.char === "c" && event.ctrl) {
      if (this.isEditing()) {
        this.cancelEdit();
        this.render();
        return true;
      }
      this.deactivate();
      return true;
    }

    if (event.type === "escape") {
      if (this.isEditing()) {
        this.cancelEdit();
        this.render();
        return true;
      }
      // First Esc clears filter, second Esc closes view
      if (this.filterEnabled && this.filterText) {
        this.filterText = "";
        this.selectedIndex = 0;
        this.render();
        return true;
      }
      this.deactivate();
      return true;
    }

    if (event.type === "char" && event.char === "q" && !event.ctrl && !this.isEditing()) {
      // If filtering, treat 'q' as a filter character, not close
      if (this.filterEnabled) {
        this.filterText += event.char;
        this.selectedIndex = 0;
        this.render();
        return true;
      }
      this.deactivate();
      return true;
    }

    // Filter: typing characters filters the list
    if (this.filterEnabled && !this.isEditing() && event.type === "char" && !event.ctrl && !event.alt) {
      this.filterText += event.char;
      this.selectedIndex = 0;
      this.render();
      return true;
    }

    // Filter: backspace removes last filter character
    if (this.filterEnabled && !this.isEditing() && event.type === "backspace" && this.filterText) {
      this.filterText = this.filterText.slice(0, -1);
      this.selectedIndex = 0;
      this.render();
      return true;
    }

    if (!this.isEditing()) {
      if (event.type === "arrow" && event.direction === "up") {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.render();
        return true;
      }
      if (event.type === "arrow" && event.direction === "down") {
        this.selectedIndex = Math.min(this.getItemCount() - 1, this.selectedIndex + 1);
        this.render();
        return true;
      }
    }

    return this.handleCustomKey(event);
  }

  protected render(): void {
    const contentLines = this.renderLines();
    const title = this.getPanelTitle();
    const footer = this.getPanelFooter();
    if (title) {
      const panelLines = renderPanel({ title, footer }, contentLines);
      this.tui.setInteractiveView(panelLines);
    } else {
      this.tui.setInteractiveView(contentLines);
    }
  }

  /** Override to wrap content in a Panel. Return null for no panel. */
  protected getPanelTitle(): string | null { return null; }
  /** Override to add footer hints to the panel. */
  protected getPanelFooter(): string | undefined { return undefined; }

  protected get theme() {
    return defaultTheme;
  }

  /** Build a header line with title left-aligned and hint right-aligned. */
  protected makeHeader(title: string, hint: string): string {
    const t = this.theme;
    const width = this.tui.getTerminal().columns;
    const gap = Math.max(2, width - visibleWidth(title) - visibleWidth(hint) - 4);
    return t.bold(title) + " ".repeat(gap) + t.dim(hint);
  }

  /** Case-insensitive substring match against the current filter text. */
  protected matchesFilter(label: string): boolean {
    if (!this.filterText) return true;
    return label.toLowerCase().includes(this.filterText.toLowerCase());
  }

  /** Render the filter input line (call from renderLines when filterEnabled). */
  protected renderFilterLine(): string {
    const t = this.theme;
    if (!this.filterText) return `  ${t.dim("Type to search...")}`;
    return `  ${t.dim("Filter:")} ${this.filterText}${t.primary("▌")}`;
  }

  protected abstract getItemCount(): number;
  protected abstract handleCustomKey(event: KeyEvent): boolean;
  protected abstract renderLines(): string[];
  protected isEditing(): boolean { return false; }
  protected cancelEdit(): void { /* override if needed */ }
}
