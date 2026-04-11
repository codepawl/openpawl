/**
 * TUI-native setup wizard — multi-step flow for configuring a provider.
 * State machine: PROVIDER → [DEVICE_AUTH | OAUTH_AUTH | API_KEY] → MODEL → CONFIRM
 *
 * PROVIDER step auto-detects available providers and shows ALL providers
 * from the catalog with detected ones sorted to top and marked.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import type { DetectedProvider } from "../../providers/detect.js";
import type { OpenPawlGlobalConfig, ProviderConfigEntry } from "../../core/global-config.js";
import { InteractiveView } from "./base-view.js";
import { renderPanel } from "../../tui/components/panel.js";
import { ScrollableFilterList } from "../../tui/components/scrollable-filter-list.js";
import { handleTextInput } from "../../tui/components/input-handler.js";
import { ICONS } from "../../tui/constants/icons.js";
import { detectProviders } from "../../providers/detect.js";
import { getProviderMeta } from "../../providers/provider-catalog.js";
import { getProviderRegistry } from "../../providers/provider-registry.js";
import { validateApiKey } from "../../providers/validate.js";
import { fetchModelsForProvider } from "../../providers/model-fetcher.js";
import { getCachedModels, setCachedModels } from "../../providers/model-cache.js";
import { readGlobalConfig, writeGlobalConfig } from "../../core/global-config.js";
import { CredentialStore } from "../../credentials/credential-store.js";
import { maskCredential } from "../../credentials/masking.js";

enum WizardStep { PROVIDER, DEVICE_AUTH, OAUTH_AUTH, API_KEY, MODEL, CONFIRM }

interface ProviderItem {
  type: "provider" | "separator" | "header";
  id?: string;
  label: string;
  hint?: string;
  detected?: boolean;
}

export class SetupWizardView extends InteractiveView {
  private step = WizardStep.PROVIDER;
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
  private validationWarning: string | null = null;
  private loading = false;
  private loadingText = "";
  private healthLatency = 0;
  private prefill?: OpenPawlGlobalConfig;
  private envKeySource: string | null = null;
  private deviceUserCode = "";
  private deviceVerificationUri = "";
  private devicePolling = false;
  private deviceError: string | null = null;
  private oauthError: string | null = null;
  private oauthAuthUrl = "";
  private providerList: ScrollableFilterList<ProviderItem>;
  private modelList: ScrollableFilterList<string>;

  constructor(tui: TUI, onClose: () => void, prefill?: OpenPawlGlobalConfig) {
    super(tui, onClose);
    this.fullscreen = true;
    this.prefill = prefill;
    this.providerList = new ScrollableFilterList<ProviderItem>({
      renderItem: (item, index, selected) => this.renderProviderItem(item, index, selected),
      filterFn: (item, query) => item.label.toLowerCase().includes(query.toLowerCase()),
      emptyMessage: "No providers match",
      filterPlaceholder: "Type to search providers...",
    });
    this.modelList = new ScrollableFilterList<string>({
      renderItem: (model, _index, selected) => {
        const t = this.theme;
        const cursor = selected ? t.primary(ICONS.cursor) : t.dim("\u2502");
        return `  ${cursor} ${selected ? t.bold(model) : model}`;
      },
      filterFn: (model, query) => model.toLowerCase().includes(query.toLowerCase()),
      emptyMessage: "No models available",
      filterPlaceholder: "Type to search models...",
    });
  }

  override activate(): void {
    this.step = WizardStep.PROVIDER;
    this.selectedIndex = 0;
    this.filterEnabled = true;
    this.filterText = "";
    this.loading = true;
    this.loadingText = "Scanning for providers...";
    this.buildProviderItems();
    super.activate();
    void this.runDetection();
  }

  // ── InteractiveView abstract methods ──────────────────────

  protected getItemCount(): number {
    switch (this.step) {
      case WizardStep.PROVIDER: return this.providerList.getFilteredCount(this.filterText);
      case WizardStep.DEVICE_AUTH: return 1;
      case WizardStep.OAUTH_AUTH: return 1;
      case WizardStep.API_KEY: return 1;
      case WizardStep.MODEL: return this.modelList.getFilteredCount(this.filterText);
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
    if (event.type === "tab" && event.shift) {
      this.goBack();
      return true;
    }

    if (event.type === "escape") {
      if (this.step === WizardStep.PROVIDER) {
        this.deactivate();
      } else {
        this.goBack();
      }
      return true;
    }

    switch (this.step) {
      case WizardStep.PROVIDER: return this.handleProviderKey(event);
      case WizardStep.DEVICE_AUTH: return this.handleDeviceAuthKey(event);
      case WizardStep.OAUTH_AUTH: return this.handleOAuthAuthKey(event);
      case WizardStep.API_KEY: return this.handleApiKeyKey(event);
      case WizardStep.MODEL: return this.handleModelKey(event);
      case WizardStep.CONFIRM: return this.handleConfirmKey(event);
    }
  }

  protected override getPanelTitle(): string {
    // Auth steps replace API_KEY, so visible step count is always 4
    const stepMap: Record<WizardStep, number> = {
      [WizardStep.PROVIDER]: 1,
      [WizardStep.DEVICE_AUTH]: 2,
      [WizardStep.OAUTH_AUTH]: 2,
      [WizardStep.API_KEY]: 2,
      [WizardStep.MODEL]: 3,
      [WizardStep.CONFIRM]: 4,
    };
    const titles: Record<WizardStep, string> = {
      [WizardStep.PROVIDER]: "Select Provider",
      [WizardStep.DEVICE_AUTH]: "GitHub Copilot",
      [WizardStep.OAUTH_AUTH]: "ChatGPT Login",
      [WizardStep.API_KEY]: "API Key",
      [WizardStep.MODEL]: "Select Model",
      [WizardStep.CONFIRM]: "Confirm",
    };
    return `Setup (${stepMap[this.step]}/4) — ${titles[this.step]}`;
  }

  protected override getPanelFooter(): string {
    switch (this.step) {
      case WizardStep.PROVIDER: return this.loading ? "Scanning..." : `${ICONS.arrowUp}${ICONS.arrowDown} navigate · Enter select · Type to filter · Esc close`;
      case WizardStep.DEVICE_AUTH: return "Waiting for authorization... · Esc cancel";
      case WizardStep.OAUTH_AUTH: return "Waiting for browser login... · Esc cancel";
      case WizardStep.API_KEY: return "Type key, Enter to validate · Esc back";
      case WizardStep.MODEL: return `${ICONS.arrowUp}${ICONS.arrowDown} navigate · Enter select · Type to filter · Esc back`;
      case WizardStep.CONFIRM: return "Enter save · Esc back";
    }
  }

  protected override render(): void {

    const contentLines = this.renderLines();
    const title = this.getPanelTitle();
    const footer = this.getPanelFooter();
    const termWidth = this.tui.getTerminal().columns;
    const width = Math.max(60, Math.min(termWidth - 6, 90));
    const panelLines = renderPanel({ title, footer, width, termWidth }, contentLines);
    this.tui.setInteractiveView(panelLines);
  }

  protected renderLines(): string[] {
    switch (this.step) {
      case WizardStep.PROVIDER: return this.renderProvider();
      case WizardStep.DEVICE_AUTH: return this.renderDeviceAuth();
      case WizardStep.OAUTH_AUTH: return this.renderOAuthAuth();
      case WizardStep.API_KEY: return this.renderApiKey();
      case WizardStep.MODEL: return this.renderModel();
      case WizardStep.CONFIRM: return this.renderConfirm();
    }
  }

  // ── Step: PROVIDER (merged with detection) ────────────────

  private async runDetection(): Promise<void> {
    try {
      this.detected = await detectProviders();
    } catch {
      this.detected = [];
    }
    this.loading = false;
    this.buildProviderItems();
    this.render();
  }

  private buildProviderItems(): void {
    this.providerItems = [];
    const detectedIds = new Set(this.detected.filter((d) => d.available).map((d) => d.type));

    // Detected providers section
    if (detectedIds.size > 0) {
      this.providerItems.push({ type: "header", label: "Detected" });
      for (const d of this.detected) {
        if (!d.available) continue;
        const meta = getProviderMeta(d.type);
        const detail = d.source === "env"
          ? `${d.envKey} found in environment`
          : d.models?.length
            ? `${d.models.length} models available`
            : "running locally";
        this.providerItems.push({
          type: "provider",
          id: d.type,
          label: meta?.name ?? d.type,
          hint: detail,
          detected: true,
        });
      }
      this.providerItems.push({ type: "separator", label: "" });
    }

    // All providers section
    this.providerItems.push({ type: "header", label: "All Providers" });
    for (const def of getProviderRegistry().getAll()) {
      if (detectedIds.has(def.id)) continue;
      const meta = getProviderMeta(def.id);
      if (!meta || meta.group) continue;
      this.providerItems.push({
        type: "provider",
        id: def.id,
        label: meta.name,
        hint: meta.authMethod === "local" ? "local" : undefined,
      });
    }

    // Update the ScrollableFilterList with only selectable provider items
    this.providerList.setItems(this.providerItems.filter((i) => i.type === "provider"));
  }

  private handleProviderKey(event: KeyEvent): boolean {
    if (this.loading) return true;

    if (event.type === "enter" || (event.type === "tab" && !event.shift)) {
      const filtered = this.providerList.getFilteredItems(this.filterText);
      const item = filtered[this.selectedIndex];
      if (!item || !item.id) return true;

      this.selectedProvider = item.id;
      const meta = getProviderMeta(item.id);
      this.filterText = "";

      switch (meta?.authMethod) {
        case "local":
          this.step = WizardStep.MODEL;
          this.selectedIndex = 0;
          this.needsKey = false;
          void this.loadModels();
          break;
        case "device-oauth":
          this.step = WizardStep.DEVICE_AUTH;
          this.needsKey = false;
          void this.startDeviceAuth();
          break;
        case "oauth":
          this.step = WizardStep.OAUTH_AUTH;
          this.needsKey = false;
          void this.startOAuthAuth();
          break;
        default: // "apikey" and others
          this.needsKey = true;
          this.prepareApiKeyStep();
          this.step = WizardStep.API_KEY;
          break;
      }
      this.render();
      return true;
    }

    return true;
  }

  private renderProviderItem(item: ProviderItem, index: number, selected: boolean): string[] {
    const t = this.theme;
    const filtered = this.providerList.getFilteredItems(this.filterText);
    const lines: string[] = [];

    // Section headers at boundaries
    const detectedCount = filtered.filter((i) => i.detected).length;
    if (item.detected && (index === 0 || !filtered[index - 1]?.detected)) {
      lines.push("");
      lines.push(`  ${t.bold("Detected")}`);
      lines.push(`  ${"─".repeat(40)}`);
    }
    if (!item.detected && (index === 0 || index === detectedCount)) {
      lines.push("");
      lines.push(`  ${t.bold("All Providers")}`);
      lines.push(`  ${"─".repeat(40)}`);
    }

    const cursor = selected ? t.primary(ICONS.cursor) : t.dim("\u2502");
    const hint = item.hint ? t.dim(` \u2014 ${item.hint}`) : "";
    if (item.detected) {
      lines.push(`  ${cursor} ${t.success(ICONS.success)} ${selected ? t.bold(item.label) : item.label}${hint}`);
    } else {
      lines.push(`  ${cursor}   ${selected ? t.bold(item.label) : item.label}${hint}`);
    }

    return lines;
  }

  private renderProvider(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    if (this.loading) {
      lines.push("");
      lines.push(`  ${t.dim(this.loadingText)}`);
      lines.push("");
    }

    // Render provider list via ScrollableFilterList
    const listLines = this.providerList.renderLines({
      filterText: this.filterText,
      selectedIndex: this.selectedIndex,
      scrollOffset: this.scrollOffset,
      maxVisible: this.maxVisible,
    });
    lines.push(...listLines);

    lines.push("");
    return lines;
  }

  // ── Step: DEVICE_AUTH (GitHub Copilot) ────────────────────

  private async startDeviceAuth(): Promise<void> {
    this.loading = true;
    this.loadingText = "Starting device authorization...";
    this.deviceError = null;
    this.render();

    try {
      const { runCopilotDeviceFlow } = await import("../../providers/copilot-provider.js");
      const json = await runCopilotDeviceFlow();
      const data = JSON.parse(json) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        interval?: number;
      };

      this.deviceUserCode = data.user_code;
      this.deviceVerificationUri = data.verification_uri;

      try {
        const { default: openBrowser } = await import("open");
        await openBrowser(data.verification_uri);
      } catch { /* browser open is best-effort */ }

      this.loading = false;
      this.devicePolling = true;
      this.render();

      void this.pollDeviceToken(data.device_code, data.interval ?? 5);
    } catch (e) {
      this.loading = false;
      const msg = e instanceof Error ? e.message : String(e);
      const hint = msg.includes("fetch failed") || msg.includes("CONNECT_TIMEOUT")
        ? " (check your network connection)"
        : "";
      this.deviceError = `Failed to start device flow: ${msg}${hint}`;
      this.render();
    }
  }

  private async pollDeviceToken(deviceCode: string, interval: number): Promise<void> {
    try {
      const { pollCopilotDeviceToken } = await import("../../providers/copilot-provider.js");

      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        if (!this.devicePolling || !this.active) return;

        const token = await pollCopilotDeviceToken(deviceCode);
        if (token) {
          this.apiKey = token;
          this.devicePolling = false;
          this.step = WizardStep.MODEL;
          this.selectedIndex = 0;
          void this.loadModels();
          this.render();
          return;
        }
      }

      this.deviceError = "Authorization timed out — please try again";
      this.devicePolling = false;
      this.render();
    } catch (e) {
      this.deviceError = `Polling error: ${e instanceof Error ? e.message : String(e)}`;
      this.devicePolling = false;
      this.render();
    }
  }

  private handleDeviceAuthKey(_event: KeyEvent): boolean {
    // Consume all keys while polling; Esc is handled by handleCustomKey
    return true;
  }

  private renderDeviceAuth(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    lines.push("");
    lines.push(`  ${t.bold("Login with GitHub Copilot")}`);
    lines.push("");

    if (this.loading) {
      lines.push(`  ${t.dim(this.loadingText)}`);
    } else if (this.devicePolling) {
      lines.push(`  Go to: ${t.primary(this.deviceVerificationUri)}`);
      lines.push(`  Enter code: ${t.bold(this.deviceUserCode)}`);
      lines.push("");
      lines.push(`  ${t.dim("Waiting for authorization...")}`);
    } else if (this.deviceError) {
      lines.push(`  ${t.error(ICONS.error + " " + this.deviceError)}`);
      lines.push("");
      lines.push(`  ${t.dim("Press Esc to go back")}`);
    }

    lines.push("");
    return lines;
  }

  // ── Step: OAUTH_AUTH (ChatGPT) ───────────────────────────

  private async startOAuthAuth(): Promise<void> {
    this.loading = true;
    this.loadingText = "Starting ChatGPT login...";
    this.oauthError = null;
    this.render();

    try {
      const { generatePKCE, buildChatGPTAuthUrl, runChatGPTOAuthFlow } =
        await import("../../providers/chatgpt-auth.js");

      const { challenge } = generatePKCE();
      this.oauthAuthUrl = buildChatGPTAuthUrl(challenge);
      this.loading = false;
      this.render();

      const result = await runChatGPTOAuthFlow();
      if (result.isOk()) {
        this.apiKey = result.value.accessToken;

        // Persist refresh token via credential store
        try {
          const store = new CredentialStore();
          await store.initialize();
          await store.setCredential(this.selectedProvider, "oauthToken", result.value.accessToken);
          await store.setCredential(this.selectedProvider, "refreshToken", result.value.refreshToken);
        } catch { /* best-effort */ }

        this.step = WizardStep.MODEL;
        this.selectedIndex = 0;
        void this.loadModels();
        this.render();
      } else {
        this.oauthError = result.error.message;
        this.render();
      }
    } catch (e) {
      this.loading = false;
      this.oauthError = `Login failed: ${e instanceof Error ? e.message : String(e)}`;
      this.render();
    }
  }

  private handleOAuthAuthKey(_event: KeyEvent): boolean {
    // Consume all keys while waiting; Esc is handled by handleCustomKey
    return true;
  }

  private renderOAuthAuth(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    lines.push("");
    lines.push(`  ${t.bold("Login with ChatGPT")}`);
    lines.push("");

    if (this.loading) {
      lines.push(`  ${t.dim(this.loadingText)}`);
    } else if (this.oauthError) {
      lines.push(`  ${t.error(ICONS.error + " " + this.oauthError)}`);
      lines.push("");
      lines.push(`  ${t.dim("Press Esc to go back")}`);
    } else {
      lines.push(`  ${t.dim("Opening browser for authentication...")}`);
      lines.push("");
      lines.push(`  ${t.dim("If browser didn't open, go to:")}`);
      lines.push(`  ${t.primary(this.oauthAuthUrl)}`);
      lines.push("");
      lines.push(`  ${t.dim("Waiting for login...")}`);
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

    if (this.envKeySource) {
      if (event.type === "enter" || (event.type === "tab" && !event.shift)) {
        void this.validateAndAdvance();
        return true;
      }
      return true;
    }

    // Backspace at position 0: go back instead of deleting
    if (event.type === "backspace" && this.editCursor === 0) {
      this.goBack();
      return true;
    }

    // Component-specific: Enter validates and advances
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

    // Delegate all text editing to centralized handler
    const result = handleTextInput(event, this.editBuffer, this.editCursor);
    if (result.handled) {
      this.editBuffer = result.text;
      this.editCursor = result.cursor;
      this.validationError = null;
      this.render();
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
    this.validationWarning = result.value.warning ?? null;

    try {
      const store = new CredentialStore();
      await store.initialize();
      await store.setCredential(this.selectedProvider, "apiKey", this.apiKey);
    } catch { /* best-effort */ }

    this.loading = false;
    this.step = WizardStep.MODEL;
    this.selectedIndex = 0;
    void this.loadModels();
    this.render();
  }

  private renderApiKey(): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const meta = getProviderMeta(this.selectedProvider);
    const providerName = meta?.name ?? this.selectedProvider;

    lines.push("");
    lines.push(`  ${t.bold("Provider:")} ${providerName}`);
    lines.push("");

    if (this.envKeySource) {
      lines.push(`  ${t.success(ICONS.success)} API key found in environment`);
      lines.push(`    ${t.dim("Source:")} ${t.bold(this.envKeySource)}`);
      lines.push(`    ${t.dim("Value:")}  ${maskCredential(this.apiKey)}`);
      lines.push("");
      if (this.loading) {
        lines.push(`  ${t.dim(this.loadingText)}`);
      } else {
        lines.push(`  ${t.dim("Press Enter to validate and continue")}`);
      }
    } else if (this.loading) {
      lines.push(`  ${t.dim(this.loadingText)}`);
    } else {
      lines.push(`  ${t.dim("Enter your API key for")} ${providerName}`);
      if (meta?.keyUrl) {
        lines.push(`  ${t.dim("Get one at:")} ${t.primary(meta.keyUrl)}`);
      }
      lines.push("");
      const display = ICONS.bullet.repeat(this.editBuffer.length);
      const before = display.slice(0, this.editCursor);
      const after = display.slice(this.editCursor);
      lines.push(`  ${t.dim("Key:")} ${before}${t.primary(ICONS.block)}${after}`);
      lines.push(`        ${t.dim("(input is masked)")}`);
    }

    if (this.validationError) {
      lines.push("");
      lines.push(`  ${t.error(ICONS.error + " " + this.validationError)}`);
    }

    lines.push("");
    return lines;
  }

  // ── Step: MODEL ───────────────────────────────────────────

  private async loadModels(): Promise<void> {
    this.loading = true;
    this.loadingText = "Fetching available models...";
    this.models = [];
    this.render();

    const cached = await getCachedModels(this.selectedProvider);
    if (cached && cached.length > 0) {
      this.models = cached;
      this.loading = false;
      this.render();
      return;
    }

    try {
      const result = await fetchModelsForProvider(this.selectedProvider, this.apiKey);
      if (result.models.length > 0) {
        this.models = result.models.map((m) => m.id);
        void setCachedModels(this.selectedProvider, this.models);
      }
    } catch { /* fallback */ }

    if (this.models.length === 0) {
      const meta = getProviderMeta(this.selectedProvider);
      if (meta) {
        this.models = meta.models.map((m) => m.id);
      }
    }

    this.modelList.setItems(this.models);
    this.loading = false;
    this.render();
  }

  private handleModelKey(event: KeyEvent): boolean {
    if (event.type === "backspace" && !this.filterText) {
      this.goBack();
      return true;
    }

    if (event.type === "enter" || (event.type === "tab" && !event.shift)) {
      const filtered = this.modelList.getFilteredItems(this.filterText);
      if (filtered.length > 0 && this.selectedIndex < filtered.length) {
        this.selectedModel = filtered[this.selectedIndex]!;
        this.step = WizardStep.CONFIRM;
        this.selectedIndex = 0;
        this.filterText = "";
        this.render();
      }
      return true;
    }

    return true;
  }

  private renderModel(): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const meta = getProviderMeta(this.selectedProvider);

    lines.push("");
    lines.push(`  ${t.bold("Provider:")} ${meta?.name ?? this.selectedProvider}`);
    lines.push("");

    if (this.loading) {
      lines.push(`  ${t.dim(this.loadingText)}`);
      lines.push("");
      return lines;
    }

    if (this.models.length === 0) {
      lines.push(`  ${t.error("No models available for this provider")}`);
      lines.push(`  ${t.dim("Press Esc to go back and try another provider")}`);
      lines.push("");
      return lines;
    }

    lines.push(`  ${t.dim("Choose a default model:")}`);
    lines.push("");

    // Render model list via ScrollableFilterList
    const listLines = this.modelList.renderLines({
      filterText: this.filterText,
      selectedIndex: this.selectedIndex,
      scrollOffset: this.scrollOffset,
      maxVisible: this.maxVisible,
    });
    lines.push(...listLines);

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
    const lines: string[] = [];
    const meta = getProviderMeta(this.selectedProvider);

    lines.push("");
    lines.push(`  ${t.bold("Review your configuration:")}`);
    lines.push("");
    lines.push(`    ${t.dim("Provider")}   ${t.bold(meta?.name ?? this.selectedProvider)}`);
    lines.push(`    ${t.dim("Model")}      ${t.bold(this.selectedModel)}`);
    if (this.needsKey) {
      lines.push(`    ${t.dim("API Key")}    ${maskCredential(this.apiKey)}`);
    }
    lines.push("");

    if (this.healthLatency > 0) {
      lines.push(`  ${t.success(ICONS.success)} Connection verified (${this.healthLatency}ms)`);
      if (this.validationWarning) {
        lines.push(`  ${t.warning(ICONS.warning)} ${this.validationWarning}`);
      }
    } else {
      lines.push(`  ${t.dim("Connection will be verified on first use")}`);
    }

    lines.push("");
    lines.push(`  ${t.dim("Press Enter to save and start using OpenPawl")}`);
    lines.push("");
    return lines;
  }

  private saveConfig(): void {
    const entry: ProviderConfigEntry = {
      type: this.selectedProvider as ProviderConfigEntry["type"],
      model: this.selectedModel,
    };

    if (this.selectedProvider === "copilot") {
      entry.githubToken = this.apiKey;
      entry.authMethod = "device-oauth";
    } else if (this.selectedProvider === "chatgpt") {
      entry.oauthToken = this.apiKey;
      entry.authMethod = "oauth";
    } else {
      entry.hasCredential = this.needsKey;
    }
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

  // ── Navigation ────────────────────────────────────────────

  private goBack(): void {
    this.filterText = "";
    switch (this.step) {
      case WizardStep.PROVIDER:
        this.deactivate();
        break;
      case WizardStep.DEVICE_AUTH:
        this.devicePolling = false;
        this.step = WizardStep.PROVIDER;
        this.selectedIndex = 0;
        this.buildProviderItems();
        break;
      case WizardStep.OAUTH_AUTH:
        this.step = WizardStep.PROVIDER;
        this.selectedIndex = 0;
        this.buildProviderItems();
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

  // ── Key handler override ──────────────────────────────────

  private isFilterableStep(): boolean {
    return this.step === WizardStep.PROVIDER || this.step === WizardStep.MODEL;
  }

  override handleKey(event: KeyEvent): boolean {
    if (!this.active) return false;

    // Ctrl+C closes wizard
    if (event.type === "char" && event.char === "c" && event.ctrl) {
      this.deactivate();
      return true;
    }

    // Consume all other Ctrl+key combos
    if (event.type === "char" && event.ctrl) {
      return true;
    }

    // Escape: clear filter first, then go back
    if (event.type === "escape") {
      if (this.isFilterableStep() && this.filterText) {
        this.filterText = "";
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.render();
        return true;
      }
      return this.handleCustomKey(event);
    }

    // Consume Ctrl+arrow
    if (event.type === "arrow" && event.ctrl) {
      return true;
    }

    // Filter: typing characters in PROVIDER/MODEL steps
    if (this.isFilterableStep() && !this.isEditing() && event.type === "char" && !event.ctrl && !event.alt) {
      this.filterText += event.char;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.render();
      return true;
    }

    // Filter: backspace removes filter char (or goes back if empty)
    if (this.isFilterableStep() && !this.isEditing() && event.type === "backspace") {
      if (this.filterText) {
        this.filterText = this.filterText.slice(0, -1);
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.render();
        return true;
      }
      // Empty filter + backspace = go back (falls through to handleCustomKey)
    }

    // Arrow navigation in non-editing steps
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
}
