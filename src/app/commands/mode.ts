/**
 * /mode command — show or switch dispatch mode (solo/crew).
 * No args → interactive mode picker.
 * With args → set mode directly.
 */
import type { SlashCommand } from "../../tui/index.js";
import { ModeView } from "../interactive/mode-view.js";
import { ICONS } from "../../tui/constants/icons.js";
import type { AppMode } from "../../tui/keybindings/app-mode.js";

const VALID_MODES: AppMode[] = ["solo", "crew"];

export interface ModeCommandDeps {
  getMode: () => AppMode;
  setMode: (mode: AppMode) => void;
  updateDisplay: () => void;
}

export function createModeCommand(deps?: ModeCommandDeps): SlashCommand {
  return {
    name: "mode",
    aliases: ["md"],
    description: "Switch dispatch mode (solo/crew)",
    args: "[mode-name]",
    async execute(args, ctx) {
      const currentMode = deps?.getMode() ?? "solo";

      if (!args.trim()) {
        // Interactive mode
        if (ctx.tui) {
          const view = new ModeView(
            ctx.tui,
            currentMode,
            (mode) => {
              if (deps) {
                deps.setMode(mode as AppMode);
                deps.updateDisplay();
              }
              ctx.addMessage("system", `${ICONS.success} Mode switched to ${mode}`);
            },
            () => { /* closed */ },
          );
          view.activate();
          return;
        }

        // Fallback: static display
        ctx.addMessage("system", [
          `Current mode: ${currentMode}`,
          "",
          "Available modes:",
          `  ${ICONS.modeSolo} solo      Single agent responds to prompts`,
          `  ${ICONS.modeCrew} crew      Multi-agent crew (not yet implemented)`,
          "",
          "Switch: /mode <name> or Shift+Tab to cycle",
        ].join("\n"));
        return;
      }

      // Direct set
      const mode = args.trim().toLowerCase() as AppMode;
      if (!VALID_MODES.includes(mode)) {
        ctx.addMessage("error", `Unknown mode: ${mode}. Available: ${VALID_MODES.join(", ")}`);
        return;
      }
      if (deps) {
        deps.setMode(mode);
        deps.updateDisplay();
      }
      ctx.addMessage("system", `${ICONS.success} Mode switched to ${mode}`);
    },
  };
}
