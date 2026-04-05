/**
 * Base class for interactive TUI views.
 * Handles ↑/↓ navigation, Esc/Ctrl+C to close, mouse click routing,
 * and key handler stack management.
 * Subclasses implement getItemCount(), handleCustomKey(), and renderLines().
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { defaultTheme } from "../../tui/themes/default.js";
import { visibleWidth } from "../../tui/utils/text-width.js";
import { renderPanel } from "../../tui/components/panel.js";

export abstract class InteractiveView {
  protected selectedIndex = 0;
  protected active = false;

  // Maps screen row (1-based) → item index for click handling
  protected rowToItem: Map<number, number> = new Map();

  constructor(
    protected tui: TUI,
    protected onClose: () => void,
  ) {}

  activate(): void {
    this.active = true;
    this.selectedIndex = 0;
    this.tui.pushKeyHandler(this);
    this.tui.setClickHandler((row, _col) => this.handleScreenClick(row));
    this.render();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.tui.popKeyHandler();
    this.tui.setClickHandler(null);
    this.tui.clearInteractiveView();
    this.onClose();
  }

  /** Handle mouse click on a specific item index. Override for Enter-on-click. */
  handleClick(itemIndex: number): void {
    this.selectedIndex = itemIndex;
    this.render();
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
      this.deactivate();
      return true;
    }

    if (event.type === "char" && event.char === "q" && !event.ctrl && !this.isEditing()) {
      this.deactivate();
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
    this.rowToItem.clear();
    const contentLines = this.renderLines();
    // Wrap in Panel if subclass provides a panelTitle
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

  /** Register a rendered line as clickable for a specific item index.
   *  Call during renderLines() — lineIndex is 0-based within the interactive content. */
  protected registerClickRow(lineIndex: number, itemIndex: number): void {
    // Screen row = interactiveStartRow + lineIndex (calculated after render by TUI)
    // Store as relative offset — resolved during click handling
    this.rowToItem.set(lineIndex, itemIndex);
  }

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

  private handleScreenClick(screenRow: number): boolean {
    if (!this.active) return false;
    const baseRow = this.tui.getInteractiveStartRow();
    if (baseRow === 0) return false;

    const relativeRow = screenRow - baseRow;
    const itemIndex = this.rowToItem.get(relativeRow);
    if (itemIndex !== undefined) {
      this.handleClick(itemIndex);
      return true;
    }

    // Click outside interactive content → close view
    if (screenRow < baseRow) {
      this.deactivate();
      return true;
    }
    return false;
  }

  protected abstract getItemCount(): number;
  protected abstract handleCustomKey(event: KeyEvent): boolean;
  protected abstract renderLines(): string[];
  protected isEditing(): boolean { return false; }
  protected cancelEdit(): void { /* override if needed */ }
}
