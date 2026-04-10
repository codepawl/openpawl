/**
 * Interactive model picker — shows ONLY dynamically discovered models.
 * Groups by provider, marks current model, shows status indicators.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { SettingsView } from "./settings-view.js";
import { discoverModels, getCurrentModel, type DiscoveredModel, type ProviderStatus } from "../../providers/model-discovery.js";
import { ctp } from "../../tui/themes/default.js";
import { ScrollableFilterList } from "../../tui/components/scrollable-filter-list.js";

interface ModelItem {
  model: DiscoveredModel;
  selectable: boolean;
}


export class ModelView extends InteractiveView {
  private currentModel: string;
  private onSelect: (model: string) => void;
  private items: ModelItem[] = [];
  private providerStatuses: ProviderStatus[] = [];
  private loading = true;
  private list: ScrollableFilterList<ModelItem>;

  constructor(tui: TUI, currentModel: string, onSelect: (model: string) => void, onClose: () => void) {
    super(tui, onClose);
    this.currentModel = currentModel || getCurrentModel();
    this.onSelect = onSelect;
    this.list = new ScrollableFilterList<ModelItem>({
      renderItem: (item, index, selected) => this.renderModelItem(item, index, selected),
      filterFn: (item, query) => {
        const q = query.toLowerCase();
        return (item.model.displayName || item.model.model).toLowerCase().includes(q)
          || item.model.provider.toLowerCase().includes(q);
      },
      emptyMessage: "No models available.",
      filterPlaceholder: "Type to search models...",
    });
  }

  override activate(): void {
    this.filterEnabled = true;
    this.filterText = "";
    super.activate();
    void this.loadModels();
  }

  private async loadModels(forceRefresh = false): Promise<void> {
    this.loading = true;
    this.render();

    const result = await discoverModels(forceRefresh);
    this.providerStatuses = result.providers;
    this.items = result.models
      .filter((m) => m.status === "available" || m.status === "configured")
      .map((m) => ({ model: m, selectable: true }));
    this.list.setItems(this.items);

    // Pre-select current model and adjust scroll
    const filtered = this.list.getFilteredItems(this.filterText);
    const idx = filtered.findIndex((item) => item.model.model === this.currentModel);
    if (idx >= 0) {
      this.selectedIndex = idx;
      this.adjustScroll();
    }

    this.loading = false;
    this.render();
  }

  // +1 for the "Add provider..." action at the bottom
  protected getItemCount(): number { return this.list.getFilteredCount(this.filterText) + 1; }

  private isAddProviderSelected(): boolean {
    return this.selectedIndex === this.list.getFilteredCount(this.filterText);
  }

  private openProviderSettings(): void {
    this.deactivate();
    const view = new SettingsView(this.tui, () => { /* closed */ });
    view.activate();
  }

  private selectAndClose(): void {
    if (this.isAddProviderSelected()) {
      this.openProviderSettings();
      return;
    }
    const filtered = this.list.getFilteredItems(this.filterText);
    const item = filtered[this.selectedIndex];
    if (item?.selectable) {
      this.onSelect(item.model.model);
      this.deactivate();
    }
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (event.type === "enter") {
      this.selectAndClose();
      return true;
    }
    if (event.type === "char" && event.char === "r" && !this.loading) {
      void this.loadModels(true);
      return true;
    }
    return true;
  }

  protected override getPanelTitle(): string { return "\u26a1 Models"; }
  protected override getPanelFooter(): string { return "\u2191\u2193 navigate \u00b7 Enter select \u00b7 r refresh \u00b7 Type to filter \u00b7 Esc close"; }

  private renderModelItem(item: ModelItem, _index: number, selected: boolean): string[] {
    const t = this.theme;
    const m = item.model;
    const isCurrent = m.model === this.currentModel;
    const cursor = selected ? ctp.mauve("\u25b8 ") : "  ";
    const current = isCurrent ? ctp.green("  \u2190 current") : "";
    const ctxInfo = m.contextWindow ? t.dim(` ${Math.round(m.contextWindow / 1000)}k ctx`) : "";
    const label = selected ? t.bold(m.displayName) : m.displayName;
    return [`      ${cursor}${label}${ctxInfo}${current}`];
  }

  protected renderLines(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    if (this.loading) {
      lines.push(`    ${ctp.teal("\u25d0")} Discovering available models...`);
      lines.push("");
      return lines;
    }

    if (this.items.length === 0) {
      lines.push(`    ${ctp.overlay1("No models available.")}`);
      lines.push("");
      const addSelected = this.isAddProviderSelected();
      const addCursor = addSelected ? ctp.mauve("\u25b8 ") : "  ";
      const addLabel = addSelected
        ? t.bold(ctp.overlay1("+ Add provider..."))
        : ctp.overlay0("+ Add provider...");
      lines.push(`      ${addCursor}${addLabel}`);
      lines.push("");
      return lines;
    }

    // Render model list via ScrollableFilterList
    const listLines = this.list.renderLines({
      filterText: this.filterText,
      selectedIndex: this.selectedIndex,
      scrollOffset: this.scrollOffset,
      maxVisible: this.maxVisible,
    });
    lines.push(...listLines);

    // Show unconfigured providers
    const unconfigured = this.providerStatuses.filter((p) => p.status === "not_configured" || (p.modelCount === 0 && p.status !== "connected"));
    if (unconfigured.length > 0) {
      lines.push("");
      lines.push(`    ${ctp.overlay0("Not configured:")}`);
      for (const p of unconfigured) {
        lines.push(`      ${ctp.surface2("\u25cb")} ${ctp.overlay0(p.name)}  ${ctp.overlay0("/settings to add")}`);
      }
    }

    // "Add provider..." action item
    lines.push("");
    const addSelected = this.isAddProviderSelected();
    const addCursor = addSelected ? ctp.mauve("\u25b8 ") : "  ";
    const addLabel = addSelected
      ? t.bold(ctp.overlay1("+ Add provider..."))
      : ctp.overlay0("+ Add provider...");
    lines.push(`      ${addCursor}${addLabel}`);

    lines.push("");
    lines.push(ctp.overlay0("    /model <name> for any model \u00b7 /settings to add providers"));
    lines.push("");
    return lines;
  }
}
