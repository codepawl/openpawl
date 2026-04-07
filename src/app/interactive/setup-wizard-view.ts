/**
 * TUI-native setup wizard — 5-step flow for configuring a provider.
 * State machine: DETECT → PROVIDER → API_KEY → MODEL → CONFIRM
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import type { DetectedProvider } from "../../providers/detect.js";
import type { ProviderMeta } from "../../providers/provider-catalog.js";
import type { OpenPawlGlobalConfig, ProviderConfigEntry } from "../../core/global-config.js";
import { InteractiveView } from "./base-view.js";
import { detectProviders } from "../../providers/detect.js";
import { PROVIDER_CATALOG, getProviderMeta } from "../../providers/provider-catalog.js";
import { validateApiKey } from "../../providers/validate.js";
import { fetchModelsForProvider } from "../../providers/model-fetcher.js";
import { getCachedModels, setCachedModels } from "../../providers/model-cache.js";
import { readGlobalConfig, writeGlobalConfig } from "../../core/global-config.js";
import { CredentialStore } from "../../credentials/credential-store.js";
import { maskCredential } from "../../credentials/masking.js";

enum WizardStep { DETECT, PROVIDER, API_KEY, MODEL, CONFIRM }

interface ProviderItem {
  type: "provider" | "separator" | "expand";
  id?: string;
  label: string;
  hint?: string;
  detected?: boolean;
}

const POPULAR_IDS = ["anthropic", "openai", "ollama"];

export class SetupWizardView extends InteractiveView {
  private step = WizardStep.DETECT;
  private detected: DetectedProvider[] = [];
  private providerItems: ProviderItem[] = [];
  private selectedProvider = "";
  private needsKey = false;
  private apiKey = "";
  private editBuffer = "";
  private editCursor = 0;
  private models: string[] = [];
  private selectedModel = "";
  private validationError: string | null = null;
  private loading = false;
  private loadingText = "";
  private expanded = false;
  private healthLatency = 0;
  private prefill?: OpenPawlGlobalConfig;
  private envKeySource: string | null = null;

  constructor(tui: TUI, onClose: () => void, prefill?: OpenPawlGlobalConfig) {
    super(tui, onClose);
    this.prefill = prefill;
  }

  override activate(): void {
    this.step = WizardStep.DETECT;
    this.selectedIndex = 0;
    super.activate();
    void this.runDetection();
  }

  // ── InteractiveView abstract methods ──────────────────────

  protected getItemCount(): number {
    switch (this.step) {
      case WizardStep.DETECT: return 0;
      case WizardStep.PROVIDER: return this.getSelectableProviderCount();
      case WizardStep.API_KEY: return 1;
      case WizardStep.MODEL: return this.models.length;
      case WizardStep.CONFIRM: return 1;
    }
  }

  protected override isEditing(): boolean {
    return this.step === WizardStep.API_KEY && !this.envKeySource;
  }

  protected override cancelEdit(): void {
    this.editBuffer = "";
    this.editCursor = 0;
    this.validationError = null;
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    // Global: Shift+Tab = go back
    if (event.type === "tab" && event.shift) {
      this.goBack();
      return true;
    }

    // Override escape from base class — go back instead of close
    if (event.type === "escape") {
      if (this.step === WizardStep.DETECT || this.step === WizardStep.PROVIDER) {
        this.deactivate();
      } else {
        this.goBack();
      }
      return true;
    }

    switch (this.step) {
      case WizardStep.DETECT: return true;
      case WizardStep.PROVIDER: return this.handleProviderKey(event);
      case WizardStep.API_KEY: return this.handleApiKeyKey(event);
      case WizardStep.MODEL: return this.handleModelKey(event);
      case WizardStep.CONFIRM: return this.handleConfirmKey(event);
    }
  }

  protected override getPanelTitle(): string {
    const stepNum = this.step + 1;
    const titles: Record<WizardStep, string> = {
      [WizardStep.DETECT]: "Detecting Providers",
      [WizardStep.PROVIDER]: "Select Provider",
      [WizardStep.API_KEY]: "API Key",
      [WizardStep.MODEL]: "Select Model",
      [WizardStep.CONFIRM]: "Confirm Setup",
    };
    return `Setup (${stepNum}/5) — ${titles[this.step]}`;
  }

  protected override getPanelFooter(): string {
    switch (this.step) {
      case WizardStep.DETECT: return "Detecting...";
      case WizardStep.PROVIDER: return "↑↓ navigate · Enter select · Esc close";
      case WizardStep.API_KEY: return "Enter validate · Esc back";
      case WizardStep.MODEL: return "↑↓ navigate · Enter select · Esc back";
      case WizardStep.CONFIRM: return "Enter save · Esc back";
    }
  }

  protected renderLines(): string[] {
    switch (this.step) {
      case WizardStep.DETECT: return this.renderDetect();
      case WizardStep.PROVIDER: return this.renderProvider();
      case WizardStep.API_KEY: return this.renderApiKey();
      case WizardStep.MODEL: return this.renderModel();
      case WizardStep.CONFIRM: return this.renderConfirm();
    }
  }

  // ── Step: DETECT ──────────────────────────────────────────

  private async runDetection(): Promise<void> {
    this.loading = true;
    this.loadingText = "Detecting providers...";
    this.render();

    try {
      this.detected = await detectProviders();
    } catch {
      this.detected = [];
    }

    this.loading = false;
    this.step = WizardStep.PROVIDER;
    this.selectedIndex = 0;
    this.buildProviderItems();
    this.render();
  }

  private renderDetect(): string[] {
    const t = this.theme;
    return [
      "",
      `  ${t.dim(this.loadingText || "Detecting providers...")}`,
      "",
    ];
  }

  // ── Step: PROVIDER ────────────────────────────────────────

  private buildProviderItems(): void {
    this.providerItems = [];
    const detectedIds = new Set(this.detected.filter((d) => d.available).map((d) => d.type));

    // Detected providers first
    if (detectedIds.size > 0) {
      for (const d of this.detected) {
        if (!d.available) continue;
        const meta = getProviderMeta(d.type);
        this.providerItems.push({
          type: "provider",
          id: d.type,
          label: meta?.name ?? d.type,
          hint: d.source === "env" ? `via ${d.envKey ?? "env"}` : d.source,
          detected: true,
        });
      }
      this.providerItems.push({ type: "separator", label: "───────" });
    }

    // Popular providers not already detected
    const popularNotDetected = POPULAR_IDS.filter((id) => !detectedIds.has(id));
    for (const id of popularNotDetected) {
      const meta = getProviderMeta(id);
      if (meta) {
        this.providerItems.push({
          type: "provider",
          id,
          label: meta.name,
          hint: meta.category,
        });
      }
    }

    // Separator before expand toggle
    if (popularNotDetected.length > 0) {
      this.providerItems.push({ type: "separator", label: "───────" });
    }

    // Expand toggle
    this.providerItems.push({
      type: "expand",
      label: this.expanded ? "Hide extra providers" : "Show all providers...",
    });

    // Expanded: all remaining from catalog
    if (this.expanded) {
      const shown = new Set([...detectedIds, ...POPULAR_IDS]);
      for (const [id, meta] of Object.entries(PROVIDER_CATALOG)) {
        if (shown.has(id) || meta.group) continue;
        this.providerItems.push({
          type: "provider",
          id,
          label: meta.name,
          hint: meta.category,
        });
      }
    }
  }

  private getSelectableProviderCount(): number {
    return this.providerItems.filter((i) => i.type !== "separator").length;
  }

  private getSelectableIndex(visualIndex: number): ProviderItem | undefined {
    let selectableCount = 0;
    for (const item of this.providerItems) {
      if (item.type === "separator") continue;
      if (selectableCount === visualIndex) return item;
      selectableCount++;
    }
    return undefined;
  }

  private handleProviderKey(event: KeyEvent): boolean {
    if (event.type === "backspace") {
      this.deactivate();
      return true;
    }

    if (event.type === "enter" || (event.type === "tab" && !event.shift)) {
      const item = this.getSelectableIndex(this.selectedIndex);
      if (!item) return true;

      if (item.type === "expand") {
        this.expanded = !this.expanded;
        this.buildProviderItems();
        this.render();
        return true;
      }

      if (item.type === "provider" && item.id) {
        this.selectedProvider = item.id;
        const meta = getProviderMeta(item.id);
        this.needsKey = meta?.authMethod !== "local";

        if (this.needsKey) {
          this.prepareApiKeyStep();
          this.step = WizardStep.API_KEY;
        } else {
          this.step = WizardStep.MODEL;
          this.selectedIndex = 0;
          void this.loadModels();
        }
        this.render();
        return true;
      }
    }

    return true;
  }

  private renderProvider(): string[] {
    const t = this.theme;
    const lines: string[] = [""];
    let selectableIdx = 0;

    for (let i = 0; i < this.providerItems.length; i++) {
      const item = this.providerItems[i]!;

      if (item.type === "separator") {
        lines.push(`  ${"─".repeat(35)}`);
        continue;
      }

      const isSelected = selectableIdx === this.selectedIndex;
      this.registerClickRow(lines.length, selectableIdx);

      if (item.type === "expand") {
        const cursor = isSelected ? "▸" : "│";
        lines.push(`  ${isSelected ? t.primary(cursor) : t.dim(cursor)} ${isSelected ? t.primary(item.label) : t.dim(item.label)}`);
      } else {
        const prefix = item.detected ? t.success("✓") : " ";
        const cursor = isSelected ? "▸" : "│";
        const hint = item.hint ? t.dim(` (${item.hint})`) : "";
        if (isSelected) {
          lines.push(`  ${t.primary(cursor)} ${prefix} ${t.bold(item.label)}${hint}`);
        } else {
          lines.push(`  ${t.dim(cursor)} ${prefix} ${item.label}${hint}`);
        }
      }
      selectableIdx++;
    }

    lines.push("");
    return lines;
  }

  // ── Step: API_KEY ─────────────────────────────────────────

  private prepareApiKeyStep(): void {
    this.editBuffer = "";
    this.editCursor = 0;
    this.validationError = null;
    this.apiKey = "";
    this.envKeySource = null;

    // Check if env var already has the key
    const det = this.detected.find((d) => d.type === this.selectedProvider && d.available && d.source === "env");
    if (det?.envKey && process.env[det.envKey]) {
      this.apiKey = process.env[det.envKey]!;
      this.envKeySource = det.envKey;
    }
  }

  private handleApiKeyKey(event: KeyEvent): boolean {
    if (event.type === "backspace" && this.envKeySource) {
      this.goBack();
      return true;
    }

    // If env key is auto-filled, Enter advances
    if (this.envKeySource) {
      if (event.type === "enter" || (event.type === "tab" && !event.shift)) {
        void this.validateAndAdvance();
        return true;
      }
      return true;
    }

    // Password input editing
    if (event.type === "char" && !event.ctrl && !event.alt) {
      this.editBuffer = this.editBuffer.slice(0, this.editCursor) + event.char + this.editBuffer.slice(this.editCursor);
      this.editCursor++;
      this.validationError = null;
      this.render();
      return true;
    }
    if (event.type === "backspace") {
      if (this.editCursor > 0) {
        this.editBuffer = this.editBuffer.slice(0, this.editCursor - 1) + this.editBuffer.slice(this.editCursor);
        this.editCursor--;
      } else {
        this.goBack();
        return true;
      }
      this.validationError = null;
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
      if (!this.editBuffer.trim()) {
        this.validationError = "API key is required";
        this.render();
        return true;
      }
      this.apiKey = this.editBuffer.trim();
      void this.validateAndAdvance();
      return true;
    }

    // Paste support
    if (event.type === "paste") {
      this.editBuffer = this.editBuffer.slice(0, this.editCursor) + event.text + this.editBuffer.slice(this.editCursor);
      this.editCursor += event.text.length;
      this.validationError = null;
      this.render();
      return true;
    }

    return true;
  }

  private async validateAndAdvance(): Promise<void> {
    this.loading = true;
    this.loadingText = "Validating API key...";
    this.validationError = null;
    this.render();

    const meta = getProviderMeta(this.selectedProvider);
    const baseUrl = meta?.baseURL ?? "";
    const result = await validateApiKey(this.selectedProvider, this.apiKey, baseUrl);

    if (result.isErr()) {
      this.loading = false;
      this.validationError = result.error.message;
      this.render();
      return;
    }

    this.healthLatency = result.value.latencyMs;

    // Store credential
    try {
      const store = new CredentialStore();
      await store.initialize();
      await store.setCredential(this.selectedProvider, "apiKey", this.apiKey);
    } catch {
      // Best-effort credential storage
    }

    this.loading = false;
    this.step = WizardStep.MODEL;
    this.selectedIndex = 0;
    void this.loadModels();
    this.render();
  }

  private renderApiKey(): string[] {
    const t = this.theme;
    const lines: string[] = [""];
    const meta = getProviderMeta(this.selectedProvider);
    const providerName = meta?.name ?? this.selectedProvider;

    lines.push(`  ${t.bold("Provider:")} ${providerName}`);
    lines.push("");

    if (this.envKeySource) {
      lines.push(`  ${t.success("✓")} Using key from ${t.bold(this.envKeySource)}`);
      lines.push(`  ${t.dim(maskCredential(this.apiKey))}`);
      if (this.loading) {
        lines.push("");
        lines.push(`  ${t.dim(this.loadingText)}`);
      }
    } else if (this.loading) {
      lines.push(`  ${t.dim(this.loadingText)}`);
    } else {
      if (meta?.keyUrl) {
        lines.push(`  ${t.dim("Get your key:")} ${t.primary(meta.keyUrl)}`);
        lines.push("");
      }
      lines.push(`  API Key:`);
      const display = "•".repeat(this.editBuffer.length);
      const before = display.slice(0, this.editCursor);
      const after = display.slice(this.editCursor);
      lines.push(`  │  ${before}${t.primary("█")}${after}`);
      lines.push(`  │  ${t.dim("(input is masked)")}`);
    }

    if (this.validationError) {
      lines.push(`  │  ${t.error("✗ " + this.validationError)}`);
    }

    lines.push("");
    return lines;
  }

  // ── Step: MODEL ───────────────────────────────────────────

  private async loadModels(): Promise<void> {
    this.loading = true;
    this.loadingText = "Fetching models...";
    this.models = [];
    this.render();

    // Try cache first
    const cached = await getCachedModels(this.selectedProvider);
    if (cached && cached.length > 0) {
      this.models = cached;
      this.loading = false;
      this.render();
      return;
    }

    // Fetch live
    try {
      const result = await fetchModelsForProvider(this.selectedProvider, this.apiKey);
      if (result.models.length > 0) {
        this.models = result.models.map((m) => m.id);
        void setCachedModels(this.selectedProvider, this.models);
      }
    } catch {
      // Fallback
    }

    // Fallback to catalog models
    if (this.models.length === 0) {
      const meta = getProviderMeta(this.selectedProvider);
      if (meta) {
        this.models = meta.models.map((m) => m.id);
      }
    }

    this.loading = false;
    this.render();
  }

  private handleModelKey(event: KeyEvent): boolean {
    if (event.type === "backspace") {
      this.goBack();
      return true;
    }

    if (event.type === "enter" || (event.type === "tab" && !event.shift)) {
      if (this.models.length > 0 && this.selectedIndex < this.models.length) {
        this.selectedModel = this.models[this.selectedIndex]!;
        this.step = WizardStep.CONFIRM;
        this.selectedIndex = 0;
        this.healthLatency = 0;
        this.render();
      }
      return true;
    }

    return true;
  }

  private renderModel(): string[] {
    const t = this.theme;
    const lines: string[] = [""];

    if (this.loading) {
      lines.push(`  ${t.dim(this.loadingText)}`);
      lines.push("");
      return lines;
    }

    if (this.models.length === 0) {
      lines.push(`  ${t.dim("No models available")}`);
      lines.push("");
      return lines;
    }

    for (let i = 0; i < this.models.length; i++) {
      const isSelected = i === this.selectedIndex;
      this.registerClickRow(lines.length, i);

      const model = this.models[i]!;
      const cursor = isSelected ? "▸" : "│";
      if (isSelected) {
        lines.push(`  ${t.primary(cursor)} ${t.bold(model)}`);
      } else {
        lines.push(`  ${t.dim(cursor)} ${model}`);
      }
    }

    lines.push("");
    return lines;
  }

  // ── Step: CONFIRM ─────────────────────────────────────────

  private handleConfirmKey(event: KeyEvent): boolean {
    if (event.type === "enter" || (event.type === "tab" && !event.shift)) {
      this.saveConfig();
      return true;
    }

    return true;
  }

  private renderConfirm(): string[] {
    const t = this.theme;
    const lines: string[] = [""];
    const meta = getProviderMeta(this.selectedProvider);

    lines.push(`  ${t.bold("Provider:")}  ${meta?.name ?? this.selectedProvider}`);
    lines.push(`  ${t.bold("Model:")}     ${this.selectedModel}`);
    lines.push("");

    if (this.healthLatency > 0) {
      lines.push(`  ${t.success("✓")} Connected (${this.healthLatency}ms)`);
    }

    lines.push("");
    lines.push(`  ${t.dim("Press Enter to save configuration")}`);
    lines.push("");
    return lines;
  }

  private saveConfig(): void {
    const entry: ProviderConfigEntry = {
      type: this.selectedProvider as ProviderConfigEntry["type"],
      hasCredential: this.needsKey,
      model: this.selectedModel,
    };
    const existing = readGlobalConfig();
    const otherProviders = existing?.providers?.filter((p) => p.type !== this.selectedProvider) ?? [];
    const config: OpenPawlGlobalConfig = {
      ...(existing ?? { version: 1, dashboardPort: 9001, debugMode: false }),
      activeProvider: this.selectedProvider,
      activeModel: this.selectedModel,
      model: this.selectedModel,
      providers: [entry, ...otherProviders],
    };
    writeGlobalConfig(config);
    this.deactivate();
  }

  // ── Navigation helpers ────────────────────────────────────

  private goBack(): void {
    switch (this.step) {
      case WizardStep.DETECT:
      case WizardStep.PROVIDER:
        this.deactivate();
        break;
      case WizardStep.API_KEY:
        this.step = WizardStep.PROVIDER;
        this.selectedIndex = 0;
        this.buildProviderItems();
        break;
      case WizardStep.MODEL:
        if (this.needsKey) {
          this.step = WizardStep.API_KEY;
          this.prepareApiKeyStep();
        } else {
          this.step = WizardStep.PROVIDER;
          this.selectedIndex = 0;
          this.buildProviderItems();
        }
        break;
      case WizardStep.CONFIRM:
        this.step = WizardStep.MODEL;
        this.selectedIndex = 0;
        break;
    }
    this.render();
  }

  // ── Override base handleKey to intercept escape before base class ──

  override handleKey(event: KeyEvent): boolean {
    if (!this.active) return false;

    // Ctrl+C always closes
    if (event.type === "char" && event.char === "c" && event.ctrl) {
      this.deactivate();
      return true;
    }

    // Override 'q' to not close during wizard
    if (event.type === "char" && event.char === "q" && !event.ctrl && !this.isEditing()) {
      return true; // consume but don't close
    }

    // Intercept escape before base class handles it
    if (event.type === "escape") {
      return this.handleCustomKey(event);
    }

    // Arrow navigation in non-editing steps
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
}
