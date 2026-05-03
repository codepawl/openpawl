/**
 * Interactive team configuration view.
 *
 * Phased UI: phase 1 picks the team composition (autonomous vs custom).
 * Phase 2/3 only render when the user advances into them, so the view
 * doesn't render every section inline at once.
 *
 *   phase = "mode"      → autonomous / custom selector
 *   phase = "templates" → template picker + preview (custom mode)
 *   phase = "agents"    → manual agent editor (custom mode)
 *
 * Two UI modes — autonomous and custom — map onto three on-disk
 * TeamComposition.mode values (autonomous / template / manual) so the
 * persisted shape stays compatible with the rest of the app:
 *   autonomous       → mode: "autonomous"
 *   custom + template → mode: "template", templateId: ...
 *   custom + agents   → mode: "manual",   customAgents: ...
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { ScrollableFilterList } from "../../tui/components/scrollable-filter-list.js";
import { handleFilterInput } from "../../tui/components/input-handler.js";
import { ICONS } from "../../tui/constants/icons.js";
import type { OpenPawlTemplate, TemplateAgent } from "../../templates/types.js";
import { listTemplates } from "../../templates/template-store.js";
import { readGlobalConfigWithDefaults, writeGlobalConfig } from "../../core/global-config.js";
import { getAllAgentConfigs, isBuiltInAgent } from "../../router/agent-config.js";

type StoredMode = "autonomous" | "template" | "manual";
type UiMode = "autonomous" | "custom";
type Phase = "mode" | "templates" | "agents";

const UI_MODES: UiMode[] = ["autonomous", "custom"];

interface TemplateItem {
  template: OpenPawlTemplate;
}

// Default agents when in manual mode with no prior config
const DEFAULT_MANUAL_AGENTS: TemplateAgent[] = [
  { role: "planner", task: "Task breakdown and planning" },
  { role: "coder", task: "Implementation" },
  { role: "reviewer", task: "Code review" },
  { role: "tester", task: "Testing" },
];

export class TeamView extends InteractiveView {
  private storedMode: StoredMode = "autonomous";
  private uiMode: UiMode = "autonomous";
  private chatCollaboration = false;
  private templateId: string | null = null;
  private templates: OpenPawlTemplate[] = [];
  private selectedTemplate: OpenPawlTemplate | null = null;
  private manualAgents: TemplateAgent[] = [];

  private phase: Phase = "mode";
  private uiModeIndex = 0;
  private templateList: ScrollableFilterList<TemplateItem>;
  private templateSelectedIndex = 0;
  private templateScrollOffset = 0;
  private agentSelectedIndex = 0;

  private onUpdate: ((mode: StoredMode, templateId: string | null) => void) | null;

  constructor(
    tui: TUI,
    onUpdate: ((mode: StoredMode, templateId: string | null) => void) | null,
    onClose: () => void,
  ) {
    super(tui, onClose);
    this.onUpdate = onUpdate;
    this.templateList = new ScrollableFilterList<TemplateItem>({
      renderItem: (item, _index, selected) => this.renderTemplateItem(item, selected),
      filterFn: (item, query) => {
        const q = query.toLowerCase();
        return item.template.name.toLowerCase().includes(q)
          || item.template.id.toLowerCase().includes(q)
          || item.template.tags.some((tag) => tag.toLowerCase().includes(q));
      },
      emptyMessage: "No templates available.",
      filterPlaceholder: "Type to search templates...",
      filterThreshold: 8,
    });
  }

  override activate(): void {
    this.filterText = "";
    this.loadConfig();
    super.activate();
    void this.loadTemplates();
  }

  private loadConfig(): void {
    const config = readGlobalConfigWithDefaults();
    const team = config.team;
    if (team) {
      this.storedMode = (team.mode ?? "autonomous") as StoredMode;
      this.chatCollaboration = team.chatCollaboration ?? false;
      this.templateId = team.templateId ?? null;
      if (team.customAgents && team.customAgents.length > 0) {
        this.manualAgents = team.customAgents.map((a) => ({
          role: a.role,
          task: a.task,
          model: a.modelOverride,
        }));
      } else {
        this.manualAgents = [...DEFAULT_MANUAL_AGENTS];
      }
    } else {
      this.storedMode = "autonomous";
      this.templateId = null;
      this.manualAgents = [...DEFAULT_MANUAL_AGENTS];
    }
    this.uiMode = this.storedMode === "autonomous" ? "autonomous" : "custom";
    this.uiModeIndex = UI_MODES.indexOf(this.uiMode);
    this.phase = "mode";
  }

  private async loadTemplates(): Promise<void> {
    this.templates = await listTemplates();
    const items = this.templates.map((t) => ({ template: t }));
    this.templateList.setItems(items);

    // Pre-select current template
    if (this.templateId) {
      const idx = this.templates.findIndex((t) => t.id === this.templateId);
      if (idx >= 0) {
        this.templateSelectedIndex = idx;
        this.selectedTemplate = this.templates[idx]!;
      }
    }
    this.render();
  }

  private saveConfig(): void {
    const config = readGlobalConfigWithDefaults();
    config.team = {
      mode: this.storedMode,
      chatCollaboration: this.chatCollaboration,
      ...(this.templateId ? { templateId: this.templateId } : {}),
      ...(this.storedMode === "manual" && this.manualAgents.length > 0
        ? {
            customAgents: this.manualAgents.map((a) => ({
              role: a.role,
              ...(a.task ? { task: a.task } : {}),
              ...(a.model ? { modelOverride: a.model } : {}),
            })),
          }
        : {}),
    };
    writeGlobalConfig(config);
    this.onUpdate?.(this.storedMode, this.templateId);
  }

  // Item count depends on current phase
  protected getItemCount(): number {
    if (this.phase === "mode") return UI_MODES.length;
    if (this.phase === "templates") return this.templateList.getFilteredCount(this.filterText);
    return this.manualAgents.length + 1; // +1 for "+ Add agent..."
  }

  private getPhaseSelectedIndex(): number {
    if (this.phase === "mode") return this.uiModeIndex;
    if (this.phase === "templates") return this.templateSelectedIndex;
    return this.agentSelectedIndex;
  }

  private setPhaseSelectedIndex(index: number): void {
    if (this.phase === "mode") this.uiModeIndex = index;
    else if (this.phase === "templates") this.templateSelectedIndex = index;
    else this.agentSelectedIndex = index;
  }

  /** Apply a UI mode selection and update the on-disk discriminator. */
  private setUiMode(uiMode: UiMode): void {
    this.uiMode = uiMode;
    this.uiModeIndex = UI_MODES.indexOf(uiMode);
    if (uiMode === "autonomous") {
      this.storedMode = "autonomous";
    } else {
      // Custom: preserve template shape if a template is set, else manual.
      this.storedMode = this.templateId ? "template" : "manual";
    }
    this.saveConfig();
  }

  private goBackToMode(): void {
    this.phase = "mode";
    this.selectedIndex = this.uiModeIndex;
    this.scrollOffset = 0;
    this.filterText = "";
    this.render();
  }

  override handleKey(event: KeyEvent): boolean {
    if (!this.active) return false;

    // Ctrl+C always closes
    if (event.type === "char" && event.char === "c" && event.ctrl) {
      this.deactivate();
      return true;
    }

    if (event.type === "escape") {
      // Templates phase: clear filter first if active
      if (this.phase === "templates" && this.filterText) {
        this.filterText = "";
        this.templateSelectedIndex = 0;
        this.templateScrollOffset = 0;
        this.render();
        return true;
      }
      // Phases 2/3: step back to mode phase instead of closing
      if (this.phase !== "mode") {
        this.goBackToMode();
        return true;
      }
      this.deactivate();
      return true;
    }

    // Section-specific navigation for up/down (with wrap)
    if (event.type === "arrow" && (event.direction === "up" || event.direction === "down")) {
      const count = this.getItemCount();
      if (count === 0) return true;
      const current = this.getPhaseSelectedIndex();
      let next = current;
      if (event.direction === "up") next = current > 0 ? current - 1 : count - 1;
      if (event.direction === "down") next = current < count - 1 ? current + 1 : 0;

      this.setPhaseSelectedIndex(next);
      this.selectedIndex = next;
      this.adjustScroll();

      // Live update on mode phase: toggling navigation also commits the selection
      if (this.phase === "mode") {
        this.setUiMode(UI_MODES[next]!);
      } else if (this.phase === "templates") {
        const filtered = this.templateList.getFilteredItems(this.filterText);
        this.selectedTemplate = filtered[next]?.template ?? null;
      }
      this.render();
      return true;
    }

    // Filter input — only in templates phase
    if (this.phase === "templates") {
      const filterResult = handleFilterInput(event, this.filterText);
      if (filterResult.handled) {
        this.filterText = filterResult.text;
        this.selectedIndex = 0;
        this.templateSelectedIndex = 0;
        this.templateScrollOffset = 0;
        this.render();
        return true;
      }
    }

    return this.handleCustomKey(event);
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (event.type === "enter") {
      this.handleEnter();
      return true;
    }

    // Left/Right on mode phase: same as up/down (toggle between two options)
    if (this.phase === "mode" && event.type === "arrow") {
      if (event.direction === "left" && this.uiModeIndex > 0) {
        this.uiModeIndex -= 1;
        this.setUiMode(UI_MODES[this.uiModeIndex]!);
        this.selectedIndex = this.uiModeIndex;
        this.render();
        return true;
      }
      if (event.direction === "right" && this.uiModeIndex < UI_MODES.length - 1) {
        this.uiModeIndex += 1;
        this.setUiMode(UI_MODES[this.uiModeIndex]!);
        this.selectedIndex = this.uiModeIndex;
        this.render();
        return true;
      }
    }

    // Right arrow on templates phase: advance to agents
    if (this.phase === "templates" && event.type === "arrow" && event.direction === "right") {
      this.advanceToAgents();
      return true;
    }

    // Delete agent in agents phase
    if (this.phase === "agents" && event.type === "char" && (event.char === "d" || event.char === "x")) {
      if (this.agentSelectedIndex < this.manualAgents.length && this.manualAgents.length > 1) {
        this.manualAgents.splice(this.agentSelectedIndex, 1);
        if (this.agentSelectedIndex >= this.manualAgents.length) {
          this.agentSelectedIndex = this.manualAgents.length;
        }
        this.selectedIndex = this.agentSelectedIndex;
        this.storedMode = "manual";
        this.saveConfig();
        this.render();
        return true;
      }
    }

    return true;
  }

  private handleEnter(): void {
    if (this.phase === "mode") {
      const next = UI_MODES[this.uiModeIndex]!;
      this.setUiMode(next);
      if (next === "custom") {
        this.phase = "templates";
        this.selectedIndex = this.templateSelectedIndex;
        this.scrollOffset = 0;
      }
      this.render();
      return;
    }

    if (this.phase === "templates") {
      const filtered = this.templateList.getFilteredItems(this.filterText);
      const item = filtered[this.templateSelectedIndex];
      if (item) {
        this.templateId = item.template.id;
        this.selectedTemplate = item.template;
        this.storedMode = "template";
        this.saveConfig();
        this.render();
      }
      return;
    }

    if (this.phase === "agents") {
      // "+ Add agent..." action at the bottom
      if (this.agentSelectedIndex === this.manualAgents.length) {
        this.addDefaultAgent();
      }
      return;
    }
  }

  private advanceToAgents(): void {
    this.phase = "agents";
    // Seed from picked template if user hasn't already customised manualAgents
    // beyond defaults. The on-disk shape switches to "manual" once the user
    // edits or adds an agent — until then, leave storedMode as it was.
    this.agentSelectedIndex = Math.min(this.agentSelectedIndex, this.manualAgents.length);
    this.selectedIndex = this.agentSelectedIndex;
    this.scrollOffset = 0;
    this.render();
  }

  private addDefaultAgent(): void {
    const builtInRoles = ["planner", "coder", "reviewer", "tester", "debugger", "researcher"];
    const customConfigs = getAllAgentConfigs();
    const customIds = Object.entries(customConfigs)
      .filter(([id, cfg]) => !isBuiltInAgent(id) && cfg.custom)
      .map(([id]) => id);
    const allRoles = [...builtInRoles, ...customIds];
    const usedRoles = new Set(this.manualAgents.map((a) => a.role));
    const available = allRoles.find((r) => !usedRoles.has(r)) ?? "coder";
    const customCfg = customConfigs[available];
    this.manualAgents.push({ role: available, task: customCfg?.description ?? "" });
    this.agentSelectedIndex = this.manualAgents.length; // select "add" again
    this.selectedIndex = this.agentSelectedIndex;
    this.storedMode = "manual";
    this.saveConfig();
    this.render();
  }

  protected override getPanelTitle(): string { return `${ICONS.gear} Team Configuration`; }
  protected override getPanelFooter(): string {
    const navigate = `${ICONS.arrowUp}${ICONS.arrowDown} navigate`;
    if (this.phase === "mode") {
      return `${navigate} · ${ICONS.arrowLeft}${ICONS.arrow} toggle · Enter select · Esc close`;
    }
    if (this.phase === "templates") {
      return `${navigate} · Enter pick · ${ICONS.arrow} customize agents · Esc back`;
    }
    return `${navigate} · Enter add · d remove · Esc back`;
  }

  private renderTemplateItem(item: TemplateItem, selected: boolean): string[] {
    const t = this.theme;
    const tpl = item.template;
    const isCurrent = tpl.id === this.templateId;
    const cursor = selected ? t.primary(`${ICONS.cursor} `) : "  ";
    const currentTag = isCurrent ? t.success("  ← active") : "";
    const name = selected ? t.bold(tpl.name) : tpl.name;
    const pipeline = tpl.pipeline
      ? t.dim(` ${tpl.pipeline.join(" → ")}`)
      : t.dim(` ${tpl.agents.map((a) => a.role).join(", ")}`);
    const cost = tpl.estimatedCostPerRun
      ? t.dim(` ~$${tpl.estimatedCostPerRun.toFixed(2)}/run`)
      : "";

    return [`    ${cursor}${name}${currentTag}`, `      ${pipeline}${cost}`];
  }

  protected renderLines(): string[] {
    if (this.phase === "mode") return this.renderModePhase();
    if (this.phase === "templates") return this.renderTemplatesPhase();
    return this.renderAgentsPhase();
  }

  private renderModePhase(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    lines.push(`  ${t.bold("Team composition")}`);
    lines.push("");

    for (let i = 0; i < UI_MODES.length; i++) {
      const m = UI_MODES[i]!;
      const isSelected = this.uiModeIndex === i;
      const isCurrent = m === this.uiMode;
      const icon = isCurrent ? ICONS.diamond : "○";
      const cursor = isSelected ? t.primary(`${ICONS.cursor} `) : "  ";
      const label = isSelected ? t.bold(m) : isCurrent ? m : t.dim(m);
      lines.push(`    ${cursor}${icon} ${label}`);
    }
    lines.push("");

    const previewMode = UI_MODES[this.uiModeIndex]!;
    if (previewMode === "autonomous") {
      lines.push(`  ${t.dim("Team will be composed automatically based on your goal.")}`);
    } else {
      const tplLabel = this.templateId
        ? `${t.dim("Template:")} ${this.selectedTemplate?.name ?? this.templateId}`
        : t.dim("No template selected — pick one or customize agents directly.");
      lines.push(`  ${tplLabel}`);
      lines.push(`  ${t.dim(`Agents: ${this.manualAgents.length} configured`)}`);
      lines.push(`  ${t.dim("Press Enter to configure.")}`);
    }
    lines.push("");

    const collabIcon = this.chatCollaboration ? ICONS.success : "○";
    const collabLabel = this.chatCollaboration ? "enabled" : "disabled";
    lines.push(`  ${t.dim("Chat collaboration:")} ${collabIcon} ${collabLabel}`);
    lines.push(`  ${t.dim("When enabled, auto-detect collab-worthy prompts in solo mode.")}`);
    lines.push("");

    return lines;
  }

  private renderTemplatesPhase(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    const filterHint = this.filterText
      ? `${t.dim("filter:")} ${this.filterText}${t.primary("▌")}`
      : t.dim("type to search");
    lines.push(`  ${t.bold("Templates")}  ${filterHint}`);
    lines.push("");

    if (this.templates.length === 0) {
      lines.push(`    ${t.dim("Loading templates...")}`);
      lines.push("");
      return lines;
    }

    // Reserve room for header (2), preview (~7 when shown), padding (2)
    const previewLines = this.selectedTemplate ? 7 : 0;
    const listMaxVisible = Math.max(3, this.maxVisible - 4 - previewLines);
    const listLines = this.templateList.renderLines({
      filterText: this.filterText,
      selectedIndex: this.templateSelectedIndex,
      scrollOffset: this.templateScrollOffset,
      maxVisible: listMaxVisible,
    });
    lines.push(...listLines);

    if (this.selectedTemplate && this.maxVisible > 10) {
      lines.push("");
      lines.push(`  ${t.bold("── Preview")} ${t.dim("─".repeat(30))}`);
      lines.push(`    ${t.dim(this.selectedTemplate.description)}`);
      lines.push("");
      for (const agent of this.selectedTemplate.agents) {
        const task = agent.task ? t.dim(` — ${agent.task}`) : "";
        lines.push(`    ${ICONS.bullet} ${agent.role}${task}`);
      }
    }
    lines.push("");

    return lines;
  }

  private renderAgentsPhase(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    lines.push(`  ${t.bold("Current Team")}`);
    lines.push("");

    for (let i = 0; i < this.manualAgents.length; i++) {
      const agent = this.manualAgents[i]!;
      const isSelected = this.agentSelectedIndex === i;
      const cursor = isSelected ? t.primary(`${ICONS.cursor} `) : "  ";
      const label = isSelected ? t.bold(agent.role) : agent.role;
      const task = agent.task ? t.dim(` (${agent.task})`) : "";
      lines.push(`    ${cursor}${label}${task}`);
    }

    const addSelected = this.agentSelectedIndex === this.manualAgents.length;
    const addCursor = addSelected ? t.primary(`${ICONS.cursor} `) : "  ";
    const addLabel = addSelected ? t.bold("+ Add agent...") : t.dim("+ Add agent...");
    lines.push(`    ${addCursor}${addLabel}`);
    lines.push("");

    return lines;
  }
}
