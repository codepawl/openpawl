/**
 * Interactive model picker — shows ONLY dynamically discovered models.
 * Groups by provider, marks current model, shows status indicators.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { discoverModels, getCurrentModel, type DiscoveredModel, type ProviderStatus } from "../../providers/model-discovery.js";
import { ctp } from "../../tui/themes/default.js";

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

  constructor(tui: TUI, currentModel: string, onSelect: (model: string) => void, onClose: () => void) {
    super(tui, onClose);
    this.currentModel = currentModel || getCurrentModel();
    this.onSelect = onSelect;
  }

  override activate(): void {
    super.activate();
    void this.loadModels();
  }

  private async loadModels(): Promise<void> {
    this.loading = true;
    this.render();

    const result = await discoverModels();
    this.providerStatuses = result.providers;
    this.items = result.models
      .filter((m) => m.status === "available" || m.status === "configured")
      .map((m) => ({ model: m, selectable: true }));

    // Pre-select current model
    const idx = this.items.findIndex((item) => item.model.model === this.currentModel);
    if (idx >= 0) this.selectedIndex = idx;

    this.loading = false;
    this.render();
  }

  protected getItemCount(): number { return this.items.length; }

  private selectAndClose(): void {
    const item = this.items[this.selectedIndex];
    if (item?.selectable) {
      this.onSelect(item.model.model);
      this.deactivate();
    }
  }

  override handleClick(itemIndex: number): void {
    if (itemIndex >= 0 && itemIndex < this.items.length) {
      this.selectedIndex = itemIndex;
      this.selectAndClose();
    }
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (event.type === "enter") {
      this.selectAndClose();
      return true;
    }
    return true;
  }

  protected override getPanelTitle(): string { return "\u26a1 Models"; }
  protected override getPanelFooter(): string { return "\u2191\u2193 navigate \u00b7 Enter select \u00b7 Esc close"; }

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
      lines.push(`    ${ctp.overlay0("Run /settings to configure a provider.")}`);
      lines.push("");
      return lines;
    }

    // Group available models by provider
    let lastProvider = "";
    let itemIdx = 0;
    for (const item of this.items) {
      const m = item.model;
      const isSelected = itemIdx === this.selectedIndex;
      const isCurrent = m.model === this.currentModel;

      if (m.provider !== lastProvider) {
        if (lastProvider) lines.push("");
        const status = this.providerStatuses.find((p) => p.id === m.provider);
        const dot = status?.status === "connected" ? ctp.green("\u25cf") : ctp.yellow("\u25d0");
        lines.push(`    ${dot} ${t.dim(m.provider)}`);
        lastProvider = m.provider;
      }

      const cursor = isSelected ? ctp.mauve("\u25b8 ") : "  ";
      const current = isCurrent ? ctp.green("  \u2190 current") : "";
      const ctxInfo = m.contextWindow ? t.dim(` ${Math.round(m.contextWindow / 1000)}k ctx`) : "";
      this.registerClickRow(lines.length, itemIdx);

      if (isSelected) {
        lines.push(`      ${cursor}${t.bold(m.displayName)}${ctxInfo}${current}`);
      } else {
        lines.push(`      ${cursor}${m.displayName}${ctxInfo}${current}`);
      }
      itemIdx++;
    }

    // Show unconfigured providers
    const unconfigured = this.providerStatuses.filter((p) => p.status === "not_configured" || (p.modelCount === 0 && p.status !== "connected"));
    if (unconfigured.length > 0) {
      lines.push("");
      lines.push(`    ${ctp.overlay0("Not configured:")}`);
      for (const p of unconfigured) {
        lines.push(`      ${ctp.surface2("\u25cb")} ${ctp.overlay0(p.name)}  ${ctp.overlay0("/settings to add")}`);
      }
    }

    lines.push("");
    lines.push(ctp.overlay0("    /model <name> for any model \u00b7 /settings to add providers"));
    lines.push("");
    return lines;
  }
}
