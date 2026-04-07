/**
 * /setup command — run setup wizard.
 */
import type { SlashCommand } from "../../tui/index.js";
import { SetupWizardView } from "../interactive/setup-wizard-view.js";

export function createSetupCommand(): SlashCommand {
  return {
    name: "setup",
    description: "Run setup wizard",
    async execute(_args, ctx) {
      if (!ctx.tui) {
        ctx.addMessage("error", "Setup wizard requires TUI. Run: openpawl setup");
        return;
      }
      let prefill;
      try {
        const { readGlobalConfig } = await import("../../core/global-config.js");
        prefill = readGlobalConfig() ?? undefined;
      } catch { /* first run — no config */ }
      const wizard = new SetupWizardView(ctx.tui, () => { /* closed */ }, prefill);
      wizard.activate();
    },
  };
}
