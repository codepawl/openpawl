/**
 * Interactive settings editor.
 * Navigate with ↑/↓, Enter to edit, Esc to close.
 * Select fields show a picker, text/password show inline input.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { getProviderRegistry } from "../../providers/provider-registry.js";
import { ScrollableFilterList } from "../../tui/components/scrollable-filter-list.js";
import { handleTextInput, handleFilterInput } from "../../tui/components/input-handler.js";
import { ICONS } from "../../tui/constants/icons.js";
import {
  getActiveProviderName,
  getActiveModel,
  getActiveProvider,
  setActiveProvider,
  setActiveModel,
} from "../../core/provider-config.js";
import { getActiveProviderState } from "../../providers/active-state.js";
import { getProviderMeta } from "../../providers/provider-catalog.js";

interface SettingField {
  key: string;
  label: string;
  description: string;
  type: "text" | "select" | "password" | "number";
  options?: string[];
  validate?: (value: string) => string | null;
}

const FIELDS: SettingField[] = [
  { key: "provider", label: "provider", description: "LLM provider", type: "select", options: [] /* populated at runtime from ProviderRegistry */ },
  { key: "model", label: "model", description: "Active model", type: "select", options: [] },
  { key: "apikey", label: "apikey", description: "API key", type: "password" },
  { key: "mode", label: "mode", description: "Default execution mode", type: "select", options: ["auto", "ask", "build", "brainstorm", "loop-hell"] },
  { key: "maxCycles", label: "maxCycles", description: "Max cycles per task", type: "number", validate: (v) => { const n = parseInt(v); return isNaN(n) || n < 1 || n > 50 ? "Must be 1-50" : null; } },
  { key: "temperature", label: "temperature", description: "LLM temperature", type: "number", validate: (v) => { const n = parseFloat(v); return isNaN(n) || n < 0 || n > 2 ? "Must be 0-2" : null; } },
];

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "deepseek/deepseek-chat",
  bedrock: "anthropic.claude-sonnet-4-20250514-v1:0",
  ollama: "llama3.3",
  deepseek: "deepseek-chat",
};

export class SettingsView extends InteractiveView {
  private editing = false;
  private editBuffer = "";
  private editCursor = 0;
  private selectIndex = 0;
  private selectScrollOffset = 0;
  private selectFilterText = "";
  private editError: string | null = null;
  private values: Map<string, string> = new Map();
  private connectionStatus: Map<string, string> = new Map();
  private selectList: ScrollableFilterList<string>;

  constructor(tui: TUI, onClose: () => void) {
    super(tui, onClose);
    this.selectList = new ScrollableFilterList<string>({
      renderItem: (opt, index, selected) => {
        const t = this.theme;
        return `  \u2502  ${selected ? t.primary(`${ICONS.cursor} ` + opt) : "  " + opt}`;
      },
      filterFn: (opt, query) => opt.toLowerCase().includes(query.toLowerCase()),
      emptyMessage: "No matches",
      filterPlaceholder: "Type to filter...",
      showFilter: false, // we render the filter inline in the select header
    });
  }

  override activate(): void {
    // Populate provider options from registry on first activation
    const providerField = FIELDS.find((f) => f.key === "provider");
    if (providerField && providerField.options!.length === 0) {
      providerField.options = getProviderRegistry().getAll().map((d) => d.id);
    }
    this.loadValues();
    super.activate();
  }

  protected getItemCount(): number { return FIELDS.length; }
  protected override isEditing(): boolean { return this.editing; }

  protected override cancelEdit(): void {
    this.editing = false;
    this.editError = null;
    this.selectFilterText = "";
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (this.editing) return this.handleEditKey(event);

    if (event.type === "enter") {
      this.startEditing();
      return true;
    }
    return true; // consume all keys while open
  }

  /** Check if a field is disabled based on dependencies. */
  private isFieldDisabled(field: SettingField): boolean {
    // Model depends on provider — disable when provider not set
    if (field.key === "model" && !this.values.get("provider")) return true;
    return false;
  }

  /** Whether the current provider requires an API key. */
  private providerNeedsApiKey(providerId?: string): boolean {
    const id = providerId ?? this.values.get("provider");
    if (!id) return false;
    const meta = getProviderMeta(id);
    return meta?.authMethod === "apikey" || meta?.authMethod === "credentials";
  }

  /** Navigate to a field by key and optionally start editing it. */
  private goToField(key: string, autoEdit = false): void {
    const idx = FIELDS.findIndex((f) => f.key === key);
    if (idx >= 0) {
      this.selectedIndex = idx;
      this.adjustScroll();
      if (autoEdit) {
        this.startEditing();
      } else {
        this.render();
      }
    }
  }

  /** Keep selectIndex visible within the scrolled select option list. */
  private adjustSelectScroll(optionCount: number): void {
    const maxOpts = Math.max(3, this.maxVisible - 4);
    if (optionCount <= maxOpts) {
      this.selectScrollOffset = 0;
      return;
    }
    if (this.selectIndex < this.selectScrollOffset) {
      this.selectScrollOffset = this.selectIndex;
    } else if (this.selectIndex >= this.selectScrollOffset + maxOpts) {
      this.selectScrollOffset = this.selectIndex - maxOpts + 1;
    }
  }

  private startEditing(): void {
    if (this.selectedIndex < 0 || this.selectedIndex >= FIELDS.length) return;
    const field = FIELDS[this.selectedIndex]!;
    if (this.isFieldDisabled(field)) {
      this.editError = "Set provider first";
      this.render();
      return;
    }

    // Dynamic model discovery — load real models for the model field
    if (field.key === "model") {
      void this.loadAndEditModels(field);
      return;
    }

    this.editing = true;
    this.editError = null;

    if (field.type === "select") {
      const opts = field.options ?? [];
      this.selectList.setItems(opts);
      this.selectFilterText = "";
      const current = this.values.get(field.key) ?? "";
      this.selectIndex = opts.indexOf(current);
      if (this.selectIndex < 0) this.selectIndex = 0;
      this.selectScrollOffset = 0;
      this.adjustSelectScroll(opts.length);
    } else {
      const raw = this.getRawValue(field.key);
      this.editBuffer = raw;
      this.editCursor = this.editBuffer.length;
    }
    this.render();
  }

  private async loadAndEditModels(field: SettingField): Promise<void> {
    const selectedProvider = this.values.get("provider") ?? "";
    this.editError = "Loading models...";
    this.render();

    try {
      const { discoverModels } = await import("../../providers/model-discovery.js");
      const result = await discoverModels(true); // force refresh

      // Filter to selected provider only
      let available = result.models.filter(
        (m) => (m.status === "available" || m.status === "configured") &&
               (!selectedProvider || m.provider === selectedProvider),
      );

      // Fallback: show default models from registry if live discovery found nothing
      if (available.length === 0 && selectedProvider) {
        const defaults = getProviderRegistry().getDefinition(selectedProvider)?.defaultModels ?? [];
        available = defaults.map((id) => ({
          provider: selectedProvider,
          model: id,
          displayName: id,
          status: "configured" as const,
        }));
      }

      if (available.length === 0) {
        this.editError = selectedProvider
          ? `No models found for ${selectedProvider}. Is it running?`
          : "No models found. Is your provider running?";
        this.render();
        return;
      }

      field.options = available.map((m) => m.model);
      this.selectList.setItems(field.options);
      this.selectFilterText = "";
      this.editing = true;
      this.editError = null;

      const current = this.values.get("model") ?? "";
      this.selectIndex = field.options.indexOf(current);
      if (this.selectIndex < 0) this.selectIndex = 0;
      this.selectScrollOffset = 0;
      this.adjustSelectScroll(field.options.length);
      this.render();
    } catch {
      this.editError = "Failed to discover models";
      this.render();
    }
  }

  private handleEditKey(event: KeyEvent): boolean {
    const field = FIELDS[this.selectedIndex]!;

    if (field.type === "select") {
      const filtered = this.selectList.getFilteredItems(this.selectFilterText);
      const filteredCount = filtered.length;

      if (event.type === "arrow" && event.direction === "up") {
        if (filteredCount > 0) {
          this.selectIndex = Math.max(0, this.selectIndex - 1);
          this.adjustSelectScroll(filteredCount);
        }
        this.render();
        return true;
      }
      if (event.type === "arrow" && event.direction === "down") {
        if (filteredCount > 0) {
          this.selectIndex = Math.min(filteredCount - 1, this.selectIndex + 1);
          this.adjustSelectScroll(filteredCount);
        }
        this.render();
        return true;
      }
      if (event.type === "enter") {
        const selected = filtered[this.selectIndex];
        if (selected) this.saveField(field.key, selected);
        this.editing = false;
        this.selectFilterText = "";
        this.render();
        return true;
      }
      if (event.type === "escape") {
        if (this.selectFilterText) {
          // First Esc clears filter
          this.selectFilterText = "";
          this.selectIndex = 0;
          this.selectScrollOffset = 0;
          this.render();
        } else {
          this.editing = false;
          this.render();
        }
        return true;
      }
      // Type to filter (supports char, backspace, Ctrl+W, Ctrl+U)
      {
        const filterResult = handleFilterInput(event, this.selectFilterText);
        if (filterResult.handled) {
          this.selectFilterText = filterResult.text;
          this.selectIndex = 0;
          this.selectScrollOffset = 0;
          this.render();
          return true;
        }
      }
      return true;
    }

    // Component-specific: Enter saves, Escape cancels
    if (event.type === "enter") {
      if (field.validate) {
        const err = field.validate(this.editBuffer);
        if (err) { this.editError = err; this.render(); return true; }
      }
      this.saveField(field.key, this.editBuffer);
      this.editing = false;
      this.editError = null;
      this.render();
      return true;
    }
    if (event.type === "escape") {
      this.editing = false;
      this.editError = null;
      this.render();
      return true;
    }

    // Delegate all text editing to centralized handler
    const result = handleTextInput(event, this.editBuffer, this.editCursor);
    if (result.handled) {
      this.editBuffer = result.text;
      this.editCursor = result.cursor;
      this.editError = null;
      this.render();
    }
    return true;
  }

  protected override getPanelTitle(): string { return `${ICONS.gear} Settings`; }
  protected override getPanelFooter(): string {
    if (this.editing) {
      const field = FIELDS[this.selectedIndex];
      if (field?.type === "select") {
        return `${ICONS.arrowUp}${ICONS.arrowDown} navigate \u00b7 Type to filter \u00b7 Enter select \u00b7 Esc back`;
      }
      return "Enter save \u00b7 Esc cancel";
    }
    return `${ICONS.arrowUp}${ICONS.arrowDown} navigate \u00b7 Enter edit \u00b7 Esc close`;
  }

  protected renderLines(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    for (let i = 0; i < FIELDS.length; i++) {
      const field = FIELDS[i]!;
      const isSelected = i === this.selectedIndex;
      const disabled = this.isFieldDisabled(field);
      // Model shows "(not set)" when provider is empty regardless of stored value
      const rawValue = disabled ? "" : (this.values.get(field.key) ?? "");
      const value = rawValue || "(not set)";
      const status = this.connectionStatus.get(field.key);
      const statusStr = status === "ok" ? t.success(` ${ICONS.success}`) : status === "fail" ? t.error(` ${ICONS.error}`) : "";

      if (isSelected && this.editing) {
        if (field.type === "select") {
          const maxOpts = Math.max(3, this.maxVisible - 4);
          const headerLabel = this.selectFilterText
            ? `${field.label} ${t.dim("filter:")} ${this.selectFilterText}${t.primary("\u25cc")}`
            : field.label;
          lines.push(`  \u270e ${t.bold(headerLabel)} ${"─".repeat(Math.max(5, 30 - (this.selectFilterText.length)))}`);
          const selectLines = this.selectList.renderLines({
            filterText: this.selectFilterText,
            selectedIndex: this.selectIndex,
            scrollOffset: this.selectScrollOffset,
            maxVisible: maxOpts,
          });
          lines.push(...selectLines);
          lines.push(`  ${"─".repeat(35)}`);
        } else {
          const display = field.type === "password"
            ? ICONS.bullet.repeat(this.editBuffer.length)
            : this.editBuffer;
          const before = display.slice(0, this.editCursor);
          const after = display.slice(this.editCursor);
          lines.push(`  \u270e ${t.bold(field.label)} ${"─".repeat(30)}`);
          lines.push(`  \u2502  ${before}${t.primary(ICONS.block)}${after}`);
          if (field.type === "password") lines.push(`  \u2502  ${t.dim("(input is masked)")}`);
          if (this.editError) lines.push(`  \u2502  ${t.error(this.editError)}`);
          lines.push(`  ${"─".repeat(35)}`);
        }
      } else {

        const cursor = isSelected ? ICONS.cursor : "\u2502";
        const label = field.label.padEnd(16);
        const displayValue = this.maskDisplay(field.key, value).padEnd(18);
        const desc = t.dim(field.description);
        if (disabled) {
          // Grayed out — field depends on unset parent
          lines.push(`  ${t.dim("\u2502")} ${t.dim(label)} ${t.dim(displayValue)}  ${t.dim(desc)}`);
        } else if (isSelected) {
          lines.push(`  ${t.primary(cursor)} ${t.bold(label)} ${displayValue}${statusStr}  ${desc}`);
        } else {
          lines.push(`  ${t.dim(cursor)} ${label} ${t.dim(displayValue)}${statusStr}  ${desc}`);
        }
      }
    }

    lines.push("");
    return lines;
  }

  private async loadValues(): Promise<void> {
    try {
      // Provider/model from unified provider-config (single source of truth)
      const providerName = getActiveProviderName();
      const model = getActiveModel();
      if (providerName) this.values.set("provider", providerName);
      if (model) this.values.set("model", model);

      // Connection status from ActiveProviderState
      if (getActiveProviderState().connectionStatus === "connected") {
        this.connectionStatus.set("provider", "ok");
      }

      // API key from provider config entry
      const entry = getActiveProvider();
      if (entry?.apiKey) {
        this.values.set("apikey", entry.apiKey);
      } else if (entry?.hasCredential) {
        this.values.set("apikey", "(stored in credential store)");
      }

      // Project-scoped fields from project config
      const { getConfigValue } = await import("../../core/configManager.js");
      for (const key of ["mode", "maxCycles", "temperature"]) {
        const result = getConfigValue(key, { raw: true });
        this.values.set(key, result.value ?? "");
      }
    } catch {
      // Config unavailable
    }
    this.render();
  }

  private getRawValue(key: string): string {
    return this.values.get(key) ?? "";
  }

  private maskDisplay(key: string, value: string): string {
    if (!value || value === "(not set)") return "(not set)";
    if (key === "apikey") {
      if (value.length <= 8) return "****";
      return value.slice(0, 6) + "..." + value.slice(-4);
    }
    return value;
  }

  private async saveField(key: string, value: string): Promise<void> {
    try {
      if (key === "provider") {
        // Write through unified provider-config (syncs globalConfig + ActiveProviderState)
        setActiveProvider(value);
        this.values.set(key, value);

        // Reset cached provider manager so LLM calls use the new provider
        const { resetGlobalProviderManager } = await import("../../providers/provider-factory.js");
        resetGlobalProviderManager();

        // Reset model to default for the new provider
        const defaultModel = DEFAULT_MODELS[value] ?? "";
        this.values.set("model", defaultModel);
        if (defaultModel) {
          setActiveModel(defaultModel);
        }

        // Auto-advance: apikey-based → go to apikey field; local → go to model
        if (this.providerNeedsApiKey(value)) {
          this.goToField("apikey", true);
        } else {
          this.goToField("model", true);
        }
        return;
      } else if (key === "model") {
        // Write through unified provider-config
        setActiveModel(value);
        this.values.set(key, value);
        // Reset cached provider manager so LLM calls use the new model
        const { resetGlobalProviderManager } = await import("../../providers/provider-factory.js");
        resetGlobalProviderManager();
      } else if (key === "apikey") {
        // Write to providers[] entry in global config via registry
        const provider = this.values.get("provider");
        if (provider) {
          getProviderRegistry().setConfig(provider, { apiKey: value });
        }
        this.values.set(key, value);

        // Auto-advance to model field after setting API key
        // Run health check first, then advance
        this.connectionStatus.set("apikey", "...");
        this.render();
        try {
          const { getGlobalProviderManager, resetGlobalProviderManager } = await import("../../providers/provider-factory.js");
          resetGlobalProviderManager();
          const mgr = await getGlobalProviderManager();
          const providers = mgr.getProviders();
          if (providers.length > 0) {
            const ok = await providers[0]!.healthCheck().catch(() => false);
            this.connectionStatus.set("provider", ok ? "ok" : "fail");
            this.connectionStatus.set("apikey", ok ? "ok" : "fail");
          }
        } catch {
          this.connectionStatus.set("apikey", "fail");
        }
        getProviderRegistry().refreshModels(this.values.get("provider") ?? "").catch(() => {});
        this.goToField("model", true);
        return;
      } else {
        // Project-scoped fields: mode, maxCycles, temperature
        const { setConfigValue } = await import("../../core/configManager.js");
        const result = setConfigValue(key, value);
        if ("error" in result) return;
        this.values.set(key, value);
      }

      // Health check after provider or apikey changes
      if (key === "provider" || key === "apikey") {
        this.connectionStatus.set(key, "...");
        this.render();
        try {
          const { getGlobalProviderManager, resetGlobalProviderManager } = await import("../../providers/provider-factory.js");
          resetGlobalProviderManager();
          const mgr = await getGlobalProviderManager();
          const providers = mgr.getProviders();
          if (providers.length > 0) {
            const ok = await providers[0]!.healthCheck().catch(() => false);
            this.connectionStatus.set("provider", ok ? "ok" : "fail");
            this.connectionStatus.set("apikey", ok ? "ok" : "fail");
          }
        } catch {
          this.connectionStatus.set(key, "fail");
        }
        getProviderRegistry().refreshModels(this.values.get("provider") ?? "").catch(() => {});
        this.render();
      }
    } catch {
      // Save failed silently
    }
  }
}
