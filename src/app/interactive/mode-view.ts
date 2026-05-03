/**
 * Interactive mode picker — solo / crew.
 * ↑/↓ navigate, Enter to select, Esc to close.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";
import { ICONS } from "../../tui/constants/icons.js";
import type { AppMode } from "../../tui/keybindings/app-mode.js";

interface ModeOption {
  name: AppMode;
  icon: string;
  description: string;
}

const MODES: ModeOption[] = [
  { name: "solo", icon: ICONS.modeSolo, description: "Single agent responds to prompts" },
  { name: "crew", icon: ICONS.modeCrew, description: "Multi-agent crew (not yet implemented)" },
];

export class ModeView extends InteractiveView {
  private currentMode: string;
  private onSelect: (mode: string) => void;

  constructor(tui: TUI, currentMode: string, onSelect: (mode: string) => void, onClose: () => void) {
    super(tui, onClose);
    this.currentMode = currentMode;
    this.onSelect = onSelect;
    const idx = MODES.findIndex((m) => m.name === currentMode);
    if (idx >= 0) this.selectedIndex = idx;
  }

  protected getItemCount(): number { return MODES.length; }

  private selectAndClose(): void {
    const mode = MODES[this.selectedIndex]!;
    this.currentMode = mode.name;
    this.onSelect(mode.name);
    this.deactivate();
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (event.type === "enter") {
      this.selectAndClose();
      return true;
    }
    return true;
  }

  protected override getPanelTitle(): string { return `${ICONS.bolt} Mode`; }
  protected override getPanelFooter(): string { return `${ICONS.arrowUp}${ICONS.arrowDown} navigate \u00b7 Enter select \u00b7 Esc close`; }

  protected renderLines(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    for (let i = 0; i < MODES.length; i++) {
      const mode = MODES[i]!;
      const isSelected = i === this.selectedIndex;
      const isCurrent = mode.name === this.currentMode;
      const cursor = isSelected ? t.primary(`${ICONS.cursor} `) : "  ";
      const label = `${mode.icon} ${mode.name}`.padEnd(14);
      const current = isCurrent ? t.success("(current)") : "";

      if (isSelected) {
        lines.push(`    ${cursor}${t.bold(label)} ${t.dim(mode.description)}  ${current}`);
      } else {
        lines.push(`    ${cursor}${t.dim(label)} ${t.dim(mode.description)}  ${current}`);
      }
    }

    lines.push("");
    return lines;
  }
}
