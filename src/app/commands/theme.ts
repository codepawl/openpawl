/**
 * /theme command — switch color themes with interactive picker or direct name.
 * No args → interactive theme picker.
 * With args → switch to named theme directly.
 * Persists selection to global config.
 */
import type { SlashCommand } from "../../tui/index.js";
import { ThemeView } from "../interactive/theme-view.js";
import { getThemeEngine } from "../../tui/themes/theme-engine.js";
import { ICONS } from "../../tui/constants/icons.js";

async function persistTheme(themeId: string): Promise<void> {
  const { readGlobalConfigWithDefaults, writeGlobalConfig } = await import("../../core/global-config.js");
  const config = readGlobalConfigWithDefaults();
  config.uiTheme = themeId;
  writeGlobalConfig(config);
}

export function createThemeCommand(): SlashCommand {
  return {
    name: "theme",
    aliases: ["t"],
    description: "Switch or list color themes",
    args: "[theme-name]",
    async execute(args, ctx) {
      const engine = getThemeEngine();

      if (!args.trim()) {
        // Interactive mode
        if (ctx.tui) {
          const view = new ThemeView(
            ctx.tui,
            async (themeId) => {
              engine.switchTheme(themeId);
              await persistTheme(themeId);
              ctx.addMessage("system", `${ICONS.success} Switched to ${themeId}`);
              ctx.tui?.requestRender();
            },
            () => { /* closed */ },
          );
          view.activate();
          return;
        }

        // Fallback: static list
        const themes = engine.listThemes();
        const current = engine.getCurrentId();
        const lines = ["\u2726 Themes", ""];
        for (const t of themes) {
          const marker = t.id === current ? " \u2190 current" : "";
          const variant = t.variant === "light" ? " (light)" : "";
          lines.push(`  ${t.id}${variant}${marker}`);
        }
        lines.push("", "  /theme <name> to switch");
        ctx.addMessage("system", lines.join("\n"));
        return;
      }

      // Direct switch by name
      const ok = engine.switchTheme(args.trim());
      if (ok) {
        await persistTheme(args.trim());
        ctx.addMessage("system", `${ICONS.success} Switched to ${args.trim()}`);
        ctx.tui?.requestRender();
      } else {
        const available = engine.listThemes().map((t) => t.id).join(", ");
        ctx.addMessage("error", `Unknown theme: ${args.trim()}\nAvailable: ${available}`);
      }
    },
  };
}
