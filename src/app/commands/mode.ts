/**
 * /mode command — show or switch execution mode.
 * No args → interactive mode picker.
 * With args → set mode directly.
 */
import type { SlashCommand } from "../../tui/index.js";
import { ModeView } from "../interactive/mode-view.js";
import { ICONS } from "../../tui/constants/icons.js";

const VALID_MODES = ["auto", "ask", "build", "brainstorm", "loop-hell"];

export function createModeCommand(): SlashCommand {
  return {
    name: "mode",
    aliases: ["md"],
    description: "Switch execution mode",
    args: "[mode-name]",
    async execute(args, ctx) {
      const { getConfigValue, setConfigValue } = await import("../../core/configManager.js");
      const currentResult = getConfigValue("mode", { raw: true });
      const currentMode = currentResult.value ?? "auto";

      if (!args.trim()) {
        // Interactive mode
        if (ctx.tui) {
          const view = new ModeView(
            ctx.tui,
            currentMode,
            async (mode) => {
              const result = setConfigValue("mode", mode);
              if ("error" in result) {
                ctx.addMessage("error", result.error);
              } else {
                ctx.addMessage("system", `${ICONS.success} Mode switched to ${mode}`);
              }
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
          "  auto        Auto-detect from prompt (default)",
          "  ask         Answer questions, no code changes",
          "  build       Write code, create/modify files",
          "  brainstorm  Explore multiple approaches",
          "  loop-hell   Iterate until tests pass",
          "",
          "Switch: /mode <name>",
        ].join("\n"));
        return;
      }

      // Direct set
      const mode = args.trim().toLowerCase();
      if (!VALID_MODES.includes(mode)) {
        ctx.addMessage("error", `Unknown mode: ${mode}. Available: ${VALID_MODES.join(", ")}`);
        return;
      }
      const result = setConfigValue("mode", mode);
      if ("error" in result) {
        ctx.addMessage("error", result.error);
      } else {
        ctx.addMessage("system", `${ICONS.success} Mode switched to ${mode}`);
      }
    },
  };
}
