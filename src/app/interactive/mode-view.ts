/**
 * Interactive mode picker.
 * ↑/↓ navigate, Enter to select, Esc to close.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";

interface ModeOption {
  name: string;
  description: string;
}

const MODES: ModeOption[] = [
  { name: "auto", description: "Auto-detect from prompt (default)" },
  { name: "ask", description: "Answer questions, no code changes" },
  { name: "build", description: "Write code, create/modify files" },
  { name: "brainstorm", description: "Explore multiple approaches" },
  { name: "loop-hell", description: "Iterate until tests pass" },
];

export class ModeView extends InteractiveView {
  private currentMode: string;
  private onSelect: (mode: string) => void;

  constructor(tui: TUI, currentMode: string, onSelect: (mode: string) => void, onClose: () => void) {
    super(tui, onClose);
    this.currentMode = currentMode;
    this.onSelect = onSelect;
    // Pre-select current mode
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

  override handleClick(itemIndex: number): void {
    this.selectedIndex = itemIndex;
    this.selectAndClose();
  }

  protected handleCustomKey(event: KeyEvent): boolean {
    if (event.type === "enter") {
      this.selectAndClose();
      return true;
    }
    return true;
  }

  protected override getPanelTitle(): string { return "\u26a1 Execution Mode"; }
  protected override getPanelFooter(): string { return "\u2191\u2193 navigate \u00b7 Enter select \u00b7 Esc close"; }

  protected renderLines(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    for (let i = 0; i < MODES.length; i++) {
      const mode = MODES[i]!;
      const isSelected = i === this.selectedIndex;
      const isCurrent = mode.name === this.currentMode;
      const cursor = isSelected ? t.primary("\u25b8 ") : "  ";
      const name = mode.name.padEnd(14);
      const current = isCurrent ? t.success("(current)") : "";

      this.registerClickRow(lines.length, i);
      if (isSelected) {
        lines.push(`    ${cursor}${t.bold(name)} ${t.dim(mode.description)}  ${current}`);
      } else {
        lines.push(`    ${cursor}${t.dim(name)} ${t.dim(mode.description)}  ${current}`);
      }
    }

    lines.push("");
    return lines;
  }
}
