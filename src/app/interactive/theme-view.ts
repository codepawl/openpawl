/**
 * Interactive theme picker — shows all built-in themes with live preview.
 * Two-step selection: first Enter previews (applies theme live), second Enter confirms.
 * Esc during preview reverts to original theme.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { getThemeEngine } from "../../tui/themes/theme-engine.js";
import { ICONS } from "../../tui/constants/icons.js";
import { ScrollableFilterList } from "../../tui/components/scrollable-filter-list.js";

interface ThemeItem {
  id: string;
  name: string;
  variant: "dark" | "light";
}

export class ThemeView extends InteractiveView {
  private items: ThemeItem[] = [];
  private currentId: string;
  private originalId: string;
  private onSelect: (themeId: string) => void;
  /** Theme currently being previewed (awaiting confirm), or null if browsing. */
  private previewingId: string | null = null;
  private list: ScrollableFilterList<ThemeItem>;

  constructor(tui: TUI, onSelect: (themeId: string) => void, onClose: () => void) {
    super(tui, onClose);
    this.onSelect = onSelect;
    this.currentId = getThemeEngine().getCurrentId();
    this.originalId = this.currentId;
    this.list = new ScrollableFilterList<ThemeItem>({
      renderItem: (item, _index, selected) => this.renderThemeItem(item, selected),
      filterFn: (item, query) => {
        const q = query.toLowerCase();
        return item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
      },
      emptyMessage: "No themes available.",
      filterPlaceholder: "Type to search themes...",
    });
  }

  override activate(): void {
    this.filterEnabled = true;
    this.filterText = "";
    const engine = getThemeEngine();
    this.items = engine.listThemes().map((t) => ({
      id: t.id,
      name: t.name,
      variant: t.variant as "dark" | "light",
    }));
    this.list.setItems(this.items);
    // Pre-select current theme
    const idx = this.items.findIndex((t) => t.id === this.currentId);
    if (idx >= 0) this.selectedIndex = idx;
    super.activate();
  }

  override deactivate(): void {
    // If closing while previewing, revert to original theme
    if (this.previewingId) {
      getThemeEngine().switchTheme(this.originalId);
      this.tui.requestRender();
    }
    super.deactivate();
  }

  protected getItemCount(): number {
    return this.list.getFilteredCount(this.filterText);
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (event.type === "enter") {
      const filtered = this.list.getFilteredItems(this.filterText);
      const item = filtered[this.selectedIndex];
      if (!item) return true;

      if (this.previewingId === item.id) {
        // Second Enter on same item: confirm
        this.previewingId = null;
        this.onSelect(item.id);
        this.deactivate();
      } else {
        // First Enter (or different item): preview
        this.previewingId = item.id;
        getThemeEngine().switchTheme(item.id);
        this.tui.requestRender();
        this.render();
      }
      return true;
    }

    // Navigation while previewing: revert theme, clear preview, let base handle
    if (this.previewingId) {
      if (event.type === "arrow" || (event.type === "char" && !event.ctrl && !event.alt) || event.type === "backspace") {
        getThemeEngine().switchTheme(this.originalId);
        this.previewingId = null;
        this.tui.requestRender();
        return false;
      }
    }

    return true;
  }

  protected override getPanelTitle(): string { return "\u2726 Themes"; }

  protected override getPanelFooter(): string {
    if (this.previewingId) {
      return `Enter confirm \u00b7 Esc revert \u00b7 ${ICONS.arrowUp}${ICONS.arrowDown} cancel preview`;
    }
    return `${ICONS.arrowUp}${ICONS.arrowDown} navigate \u00b7 Enter preview \u00b7 Type to filter \u00b7 Esc close`;
  }

  private renderThemeItem(item: ThemeItem, selected: boolean): string {
    const t = this.theme;
    const isCurrent = item.id === this.currentId;
    const isPreviewing = item.id === this.previewingId;
    const cursor = selected ? t.primary(`${ICONS.cursor} `) : "  ";
    const current = isCurrent ? t.success("  \u2190 current") : "";
    const preview = isPreviewing ? t.warning(`  ${ICONS.diamond} previewing`) : "";
    const variant = item.variant === "light" ? t.dim(" (light)") : t.dim(" (dark)");
    const label = selected ? t.bold(item.name) : item.name;
    return `      ${cursor}${label}${variant}${current}${preview}`;
  }

  protected renderLines(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    // Render theme list via ScrollableFilterList
    const listLines = this.list.renderLines({
      filterText: this.filterText,
      selectedIndex: this.selectedIndex,
      scrollOffset: this.scrollOffset,
      maxVisible: this.maxVisible,
    });
    lines.push(...listLines);

    lines.push("");
    if (this.previewingId) {
      const previewItem = this.items.find((i) => i.id === this.previewingId);
      const name = previewItem?.name ?? this.previewingId;
      lines.push(`    ${t.success("Like this theme?")} ${t.dim("Press Enter again to confirm")} ${t.bold(name)}`);
    } else {
      lines.push(t.dim("    /theme <name> to switch directly"));
    }
    lines.push("");
    return lines;
  }
}
