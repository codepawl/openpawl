/**
 * Interactive settings editor.
 * Navigate with ↑/↓, Enter to edit, Esc to close.
 * Select fields show a picker, text/password show inline input.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";

interface SettingField {
  key: string;
  label: string;
  description: string;
  type: "text" | "select" | "password" | "number";
  options?: string[];
  validate?: (value: string) => string | null;
}

const FIELDS: SettingField[] = [
  { key: "provider", label: "provider", description: "LLM provider", type: "select", options: ["ollama", "chatgpt", "github-copilot", "anthropic", "openai", "groq", "deepseek", "openrouter", "gemini", "grok", "mistral", "together", "fireworks", "cerebras", "perplexity", "lmstudio"] },
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
  private editError: string | null = null;
  private values: Map<string, string> = new Map();
  private connectionStatus: Map<string, string> = new Map();

  constructor(tui: TUI, onClose: () => void) {
    super(tui, onClose);
  }

  override activate(): void {
    this.loadValues();
    super.activate();
  }

  protected getItemCount(): number { return FIELDS.length; }
  protected override isEditing(): boolean { return this.editing; }

  protected override cancelEdit(): void {
    this.editing = false;
    this.editError = null;
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
      const current = this.values.get(field.key) ?? "";
      this.selectIndex = field.options?.indexOf(current) ?? 0;
      if (this.selectIndex < 0) this.selectIndex = 0;
    } else {
      const raw = this.getRawValue(field.key);
      this.editBuffer = raw;
      this.editCursor = this.editBuffer.length;
    }
    this.render();
  }

  private async loadAndEditModels(field: SettingField): Promise<void> {
    this.editError = "Loading models...";
    this.render();

    try {
      const { discoverModels } = await import("../../providers/model-discovery.js");
      const result = await discoverModels(true); // force refresh
      const available = result.models.filter((m) => m.status === "available" || m.status === "configured");

      if (available.length === 0) {
        this.editError = "No models found. Is your provider running?";
        this.render();
        return;
      }

      // Set options dynamically from discovered models
      field.options = available.map((m) => m.model);
      this.editing = true;
      this.editError = null;

      const current = this.values.get("model") ?? "";
      this.selectIndex = field.options.indexOf(current);
      if (this.selectIndex < 0) this.selectIndex = 0;
      this.render();
    } catch {
      this.editError = "Failed to discover models";
      this.render();
    }
  }

  private handleEditKey(event: KeyEvent): boolean {
    const field = FIELDS[this.selectedIndex]!;

    if (field.type === "select") {
      if (event.type === "arrow" && event.direction === "up") {
        this.selectIndex = Math.max(0, this.selectIndex - 1);
        this.render();
        return true;
      }
      if (event.type === "arrow" && event.direction === "down") {
        this.selectIndex = Math.min((field.options?.length ?? 1) - 1, this.selectIndex + 1);
        this.render();
        return true;
      }
      if (event.type === "enter") {
        const selected = field.options?.[this.selectIndex];
        if (selected) this.saveField(field.key, selected);
        this.editing = false;
        this.render();
        return true;
      }
      if (event.type === "escape") {
        this.editing = false;
        this.render();
        return true;
      }
      return true;
    }

    // Text/password/number editing
    if (event.type === "char" && !event.ctrl && !event.alt) {
      this.editBuffer = this.editBuffer.slice(0, this.editCursor) + event.char + this.editBuffer.slice(this.editCursor);
      this.editCursor++;
      this.editError = null;
      this.render();
      return true;
    }
    if (event.type === "backspace") {
      if (this.editCursor > 0) {
        this.editBuffer = this.editBuffer.slice(0, this.editCursor - 1) + this.editBuffer.slice(this.editCursor);
        this.editCursor--;
      }
      this.editError = null;
      this.render();
      return true;
    }
    if (event.type === "arrow" && event.direction === "left") {
      this.editCursor = Math.max(0, this.editCursor - 1);
      this.render();
      return true;
    }
    if (event.type === "arrow" && event.direction === "right") {
      this.editCursor = Math.min(this.editBuffer.length, this.editCursor + 1);
      this.render();
      return true;
    }
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
    return true;
  }

  override handleClick(itemIndex: number): void {
    if (itemIndex < 0 || itemIndex >= FIELDS.length) return;
    this.selectedIndex = itemIndex;
    this.startEditing();
  }

  protected override getPanelTitle(): string { return "\u2699 Settings"; }
  protected override getPanelFooter(): string { return "\u2191\u2193 navigate \u00b7 Enter edit \u00b7 Esc close"; }

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
      const statusStr = status === "ok" ? t.success(" \u2713") : status === "fail" ? t.error(" \u2717") : "";

      if (isSelected && this.editing) {
        if (field.type === "select") {
          lines.push(`  \u270e ${t.bold(field.label)} ${"─".repeat(30)}`);
          for (let j = 0; j < (field.options?.length ?? 0); j++) {
            const opt = field.options![j]!;
            const sel = j === this.selectIndex;
            // Register each option as clickable → selects that option
            this.registerClickRow(lines.length, j + FIELDS.length); // use offset to distinguish
            lines.push(`  \u2502  ${sel ? t.primary("\u25b8 " + opt) : "  " + opt}`);
          }
          lines.push(`  ${"─".repeat(35)}`);
        } else {
          const display = field.type === "password"
            ? "\u2022".repeat(this.editBuffer.length)
            : this.editBuffer;
          const before = display.slice(0, this.editCursor);
          const after = display.slice(this.editCursor);
          lines.push(`  \u270e ${t.bold(field.label)} ${"─".repeat(30)}`);
          lines.push(`  \u2502  ${before}${t.primary("\u2588")}${after}`);
          if (field.type === "password") lines.push(`  \u2502  ${t.dim("(input is masked)")}`);
          if (this.editError) lines.push(`  \u2502  ${t.error(this.editError)}`);
          lines.push(`  ${"─".repeat(35)}`);
        }
      } else {
        this.registerClickRow(lines.length, i);
        const cursor = isSelected ? "\u25b8" : "\u2502";
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
      const { getConfigValue } = await import("../../core/configManager.js");
      for (const field of FIELDS) {
        const result = getConfigValue(field.key, { raw: true });
        this.values.set(field.key, result.value ?? "");
      }

      // Override provider and model from ActiveProviderState (runtime truth)
      const { getActiveProviderState } = await import("../../providers/active-state.js");
      const active = getActiveProviderState();
      if (active.isConfigured()) {
        this.values.set("provider", active.provider);
        this.values.set("model", active.model);
        this.connectionStatus.set("provider", "ok");
      }
    } catch {
      // Config unavailable
    }
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
      const { setConfigValue } = await import("../../core/configManager.js");
      const result = setConfigValue(key, value);
      if ("error" in result) return;
      this.values.set(key, value);

      // Auto-suggest default model when provider changes
      if (key === "provider" && value) {
        const currentModel = this.values.get("model") ?? "";
        const defaultModel = DEFAULT_MODELS[value];
        if (defaultModel && !currentModel) {
          const modelResult = setConfigValue("model", defaultModel);
          if (!("error" in modelResult)) {
            this.values.set("model", defaultModel);
          }
        }
      }

      // Update ActiveProviderState when model changes
      if (key === "model" && value) {
        try {
          const { getActiveProviderState } = await import("../../providers/active-state.js");
          getActiveProviderState().setModel(value);
        } catch { /* */ }
      }

      if (key === "provider" || key === "apikey") {
        this.connectionStatus.set(key, "...");
        this.render();
        try {
          const { getGlobalProviderManager, resetGlobalProviderManager } = await import("../../providers/provider-factory.js");
          resetGlobalProviderManager();
          const mgr = getGlobalProviderManager();
          const providers = mgr.getProviders();
          if (providers.length > 0) {
            const ok = await providers[0]!.healthCheck().catch(() => false);
            this.connectionStatus.set("provider", ok ? "ok" : "fail");
            this.connectionStatus.set("apikey", ok ? "ok" : "fail");
          }
        } catch {
          this.connectionStatus.set(key, "fail");
        }
        this.render();
      }
    } catch {
      // Save failed silently
    }
  }
}
