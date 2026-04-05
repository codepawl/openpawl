/**
 * Interactive model picker.
 * Shows models grouped by provider. ↑/↓ navigate, Enter to select.
 */
import type { KeyEvent } from "../../tui/core/input.js";
import type { TUI } from "../../tui/core/tui.js";
import { InteractiveView } from "./base-view.js";

interface ModelOption {
  provider: string;
  name: string;
}

const MODELS: ModelOption[] = [
  { provider: "anthropic", name: "claude-sonnet-4-20250514" },
  { provider: "anthropic", name: "claude-opus-4-20250514" },
  { provider: "anthropic", name: "claude-haiku-4-5-20251001" },
  { provider: "openai", name: "gpt-4o" },
  { provider: "openai", name: "gpt-4o-mini" },
  { provider: "openai", name: "o3-mini" },
  { provider: "openrouter", name: "deepseek/deepseek-chat" },
  { provider: "openrouter", name: "google/gemini-2.5-pro" },
  { provider: "ollama", name: "llama3.3" },
  { provider: "ollama", name: "qwen3" },
];

export class ModelView extends InteractiveView {
  private currentModel: string;
  private onSelect: (model: string) => void;

  constructor(tui: TUI, currentModel: string, onSelect: (model: string) => void, onClose: () => void) {
    super(tui, onClose);
    this.currentModel = currentModel;
    this.onSelect = onSelect;
    const idx = MODELS.findIndex((m) => m.name === currentModel);
    if (idx >= 0) this.selectedIndex = idx;
  }

  protected getItemCount(): number { return MODELS.length; }

  private selectAndClose(): void {
    const model = MODELS[this.selectedIndex]!;
    this.onSelect(model.name);
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

  protected renderLines(): string[] {
    const t = this.theme;
    const lines: string[] = [];

    lines.push(this.makeHeader("\u26a1 Model", "[\u2191\u2193 navigate \u00b7 Enter select \u00b7 Esc close]"));
    lines.push("");

    let lastProvider = "";
    for (let i = 0; i < MODELS.length; i++) {
      const model = MODELS[i]!;
      const isSelected = i === this.selectedIndex;
      const isCurrent = model.name === this.currentModel;

      if (model.provider !== lastProvider) {
        if (lastProvider) lines.push("");
        lines.push(`    ${t.dim(model.provider)}`);
        lastProvider = model.provider;
      }

      const cursor = isSelected ? t.primary("\u25b8 ") : "  ";
      const current = isCurrent ? t.success("  (current)") : "";
      this.registerClickRow(lines.length, i);
      if (isSelected) {
        lines.push(`      ${cursor}${t.bold(model.name)}${current}`);
      } else {
        lines.push(`      ${cursor}${model.name}${current}`);
      }
    }

    lines.push("");
    lines.push(t.dim("    Or type: /model <name> for any model"));
    lines.push("");
    return lines;
  }
}
