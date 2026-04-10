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
import { handleFilterInput } from "../../tui/components/input-handler.js";

export abstract class InteractiveView {
  protected selectedIndex = 0;
  protected scrollOffset = 0;
  protected active = false;
  protected filterEnabled = false;
  protected filterText = "";
  /** When true, hides editor + status bar while the view is active. */
  protected fullscreen = false;
  /** Bound resize handler for cleanup. */
  private _resizeHandler: (() => void) | null = null;

  /** Max visible items — reads from responsive layout. */
  protected get maxVisible(): number {
    return this.tui.getLayout().maxSelectItems;
  }

  constructor(
    protected tui: TUI,
    protected onClose: () => void,
  ) {}

  activate(): void {
    this.active = true;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    if (this.fullscreen) {
      this.tui.setFixedBottomHidden("editor", true);
      this.tui.setFixedBottomHidden("status", true);
      this.tui.setFixedBottomHidden("divider", true);
      this.tui.setScrollableHidden(true);
    }
    this.tui.pushKeyHandler(this);
    // Re-render on terminal resize so panel dimensions stay correct
    this._resizeHandler = () => { if (this.active) this.render(); };
    process.stdout.on("resize", this._resizeHandler);
    this.render();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    if (this._resizeHandler) {
      process.stdout.off("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this.fullscreen) {
      this.tui.setScrollableHidden(false);
      this.tui.setFixedBottomHidden("divider", false);
      this.tui.setFixedBottomHidden("editor", false);
      this.tui.setFixedBottomHidden("status", false);
    }
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
        this.scrollOffset = 0;
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
        this.scrollOffset = 0;
        this.render();
        return true;
      }
      this.deactivate();
      return true;
    }

    // Filter: delegate to centralized handler (supports char, backspace, Ctrl+W, Ctrl+U)
    if (this.filterEnabled && !this.isEditing()) {
      const filterResult = handleFilterInput(event, this.filterText);
      if (filterResult.handled) {
        this.filterText = filterResult.text;
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.render();
        return true;
      }
    }

    if (!this.isEditing()) {
      if (event.type === "arrow" && event.direction === "up") {
        const count = this.getItemCount();
        if (count > 0) {
          this.selectedIndex = this.selectedIndex <= 0 ? count - 1 : this.selectedIndex - 1;
          this.adjustScroll();
        }
        this.render();
        return true;
      }
      if (event.type === "arrow" && event.direction === "down") {
        const count = this.getItemCount();
        if (count > 0) {
          this.selectedIndex = this.selectedIndex >= count - 1 ? 0 : this.selectedIndex + 1;
          this.adjustScroll();
        }
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
      const termWidth = this.tui.getTerminal().columns;
      const panelLines = renderPanel({ title, footer, termWidth }, contentLines);
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

  /** Adjust scrollOffset so selectedIndex stays in the visible window. */
  protected adjustScroll(): void {
    const count = this.getItemCount();
    if (count <= this.maxVisible) {
      this.scrollOffset = 0;
      return;
    }
    // Wrap-around jump: selected at 0 means we wrapped from bottom
    if (this.selectedIndex === 0) {
      this.scrollOffset = 0;
    } else if (this.selectedIndex === count - 1) {
      this.scrollOffset = count - this.maxVisible;
    }
    // Keep selected in view
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
      this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
    }
  }

  /** Get the visible window for the current scroll state. */
  protected getVisibleRange(): { start: number; end: number; aboveCount: number; belowCount: number } {
    const count = this.getItemCount();
    if (count <= this.maxVisible) {
      return { start: 0, end: count, aboveCount: 0, belowCount: 0 };
    }
    const start = this.scrollOffset;
    const end = Math.min(count, start + this.maxVisible);
    return { start, end, aboveCount: start, belowCount: count - end };
  }

  /** Wrap item lines with scroll indicators when items are hidden. */
  protected addScrollIndicators(lines: string[], aboveCount: number, belowCount: number): string[] {
    const t = this.theme;
    const result = [...lines];
    if (aboveCount > 0) {
      result.unshift(t.dim(`  ${"▲"} ${aboveCount} more`));
    }
    if (belowCount > 0) {
      result.push(t.dim(`  ${"▼"} ${belowCount} more`));
    }
    return result;
  }

  protected abstract getItemCount(): number;
  protected abstract handleCustomKey(event: KeyEvent): boolean;
  protected abstract renderLines(): string[];
  protected isEditing(): boolean { return false; }
  protected cancelEdit(): void { /* override if needed */ }
}
