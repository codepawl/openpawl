/**
 * Interactive keybinding help overlay.
 * Shows all shortcuts organized by category with search.
 */
import type { KeyEvent } from "../core/input.js";
import { visibleWidth } from "../utils/text-width.js";
import { defaultTheme } from "../themes/default.js";
import { ICONS } from "../constants/icons.js";
import { displayKey, detectPlatform } from "./platform-detect.js";
import type { LeaderBinding } from "./leader-key.js";

export interface HelpSection {
  title: string;
  icon: string;
  entries: { key: string; description: string }[];
}

export class KeybindingHelp {
  private visible = false;
  private searchQuery = "";
  private sections: HelpSection[] = [];

  show(sections: HelpSection[]): void {
    this.sections = sections;
    this.visible = true;
    this.searchQuery = "";
  }

  hide(): void {
    this.visible = false;
    this.searchQuery = "";
  }

  isVisible(): boolean {
    return this.visible;
  }

  handleKey(event: KeyEvent): boolean {
    if (!this.visible) return false;

    if (event.type === "escape" || (event.type === "char" && event.char === "q" && !event.ctrl)) {
      this.hide();
      return true;
    }

    if (event.type === "backspace" && this.searchQuery.length > 0) {
      this.searchQuery = this.searchQuery.slice(0, -1);
      return true;
    }

    if (event.type === "char" && !event.ctrl && !event.alt) {
      this.searchQuery += event.char;
      return true;
    }

    // Any other key dismisses help (when not searching)
    if (!this.searchQuery) {
      this.hide();
      return true;
    }

    return true;
  }

  render(width: number): string[] {
    if (!this.visible) return [];

    const platform = detectPlatform();
    const innerWidth = Math.min(65, width - 4);
    const pad = " ".repeat(Math.max(0, Math.floor((width - innerWidth - 4) / 2)));
    const lines: string[] = [];

    lines.push(pad + defaultTheme.dim("┌─ Keyboard Shortcuts " + "─".repeat(Math.max(0, innerWidth - 20)) + "┐"));

    // Search
    const cursor = this.searchQuery ? defaultTheme.primary("▌") : "";
    const searchLine = ` Search: ${this.searchQuery}${cursor}`;
    lines.push(pad + defaultTheme.dim("│") + searchLine + " ".repeat(Math.max(0, innerWidth + 2 - visibleWidth(searchLine))) + defaultTheme.dim("│"));
    lines.push(pad + defaultTheme.dim("│") + " ".repeat(innerWidth + 2) + defaultTheme.dim("│"));

    const query = this.searchQuery.toLowerCase();
    for (const section of this.sections) {
      const filtered = query
        ? section.entries.filter((e) =>
          e.key.toLowerCase().includes(query) || e.description.toLowerCase().includes(query))
        : section.entries;

      if (filtered.length === 0) continue;

      // Section header
      const header = ` ${section.icon} ${section.title}`;
      const sep = "─".repeat(Math.max(0, innerWidth + 1 - visibleWidth(header)));
      lines.push(pad + defaultTheme.dim("│") + defaultTheme.bold(header) + " " + defaultTheme.dim(sep) + defaultTheme.dim("│"));

      for (const entry of filtered) {
        const keyStr = displayKey(entry.key, platform);
        const keyPad = Math.max(1, 20 - visibleWidth(keyStr));
        const entryLine = `   ${keyStr}${" ".repeat(keyPad)}${entry.description}`;
        const entryPad = Math.max(0, innerWidth + 2 - visibleWidth(entryLine));
        lines.push(pad + defaultTheme.dim("│") + entryLine + " ".repeat(entryPad) + defaultTheme.dim("│"));
      }

      lines.push(pad + defaultTheme.dim("│") + " ".repeat(innerWidth + 2) + defaultTheme.dim("│"));
    }

    // Footer
    const configHint = " Customize: ~/.openpawl/keybindings.json";
    lines.push(pad + defaultTheme.dim("│") + defaultTheme.dim(configHint) + " ".repeat(Math.max(0, innerWidth + 2 - visibleWidth(configHint))) + defaultTheme.dim("│"));
    const closeHint = " Esc or q to close";
    lines.push(pad + defaultTheme.dim("│") + defaultTheme.dim(closeHint) + " ".repeat(Math.max(0, innerWidth + 2 - visibleWidth(closeHint))) + defaultTheme.dim("│"));
    lines.push(pad + defaultTheme.dim("└" + "─".repeat(innerWidth + 2) + "┘"));

    return lines;
  }
}

/** Build help sections from leader bindings and standard keybindings. */
export function buildHelpSections(leaderBindings: LeaderBinding[], leaderCombo: string): HelpSection[] {
  return [
    {
      title: "Mode",
      icon: ICONS.modeSolo,
      entries: [
        { key: "shift+tab", description: `Cycle mode (solo ${ICONS.arrow} crew)` },
        { key: "/mode <name>", description: "Set specific mode" },
      ],
    },
    {
      title: `Leader (${leaderCombo} + ...)`,
      icon: "⌨",
      entries: leaderBindings.map((b) => ({
        key: `${leaderCombo} ${b.secondKey}`,
        description: b.description || b.action,
      })),
    },
    {
      title: "Chat",
      icon: "▶",
      entries: [
        { key: "enter", description: "Submit prompt" },
        { key: "up/down", description: "Prompt history" },
        { key: "ctrl+r", description: "Search history" },
        { key: "ctrl+g", description: "Open in external editor" },
        { key: "tab", description: "Autocomplete" },
        { key: "!", description: "Shell mode (first char)" },
      ],
    },
    {
      title: "Navigation",
      icon: "◇",
      entries: [
        { key: "ctrl+p", description: "Command palette" },
        { key: "ctrl+,", description: "Settings" },
        { key: "ctrl+t", description: "Expand/collapse all tool calls" },
        { key: "escape", description: "Abort / dismiss" },
        { key: "alt+t", description: "Toggle extended thinking" },
        { key: "alt+p", description: "Model picker" },
        { key: "pageup/pagedown", description: "Scroll messages" },
        { key: "f1", description: "This help (also via palette)" },
      ],
    },
  ];
}
