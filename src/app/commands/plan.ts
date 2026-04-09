/**
 * /plan command — enter plan-only mode with read-only tools.
 * After agent responds, an inline confirmation auto-shows to execute the plan.
 */
import type { SlashCommand } from "../../tui/index.js";
import type { ModeSystem } from "../../tui/keybindings/mode-system.js";

export interface PlanCommandDeps {
  modeSystem: ModeSystem;
  updateModeDisplay: () => void;
  flashMessage: (msg: string) => void;
}

export const PLAN_SYSTEM_MESSAGE = [
  "**Plan mode active.** You are now in read-only exploration mode.",
  "",
  "Your job: explore the codebase and create a detailed plan.",
  "You can read files, list directories, and search — but you cannot modify anything.",
  "",
  "When your plan is ready, you'll be prompted to execute it.",
].join("\n");

export function createPlanCommand(deps: PlanCommandDeps): SlashCommand {
  return {
    name: "plan",
    description: "Enter plan-only mode (read-only tools, auto-execute when ready)",
    async execute(_args, ctx) {
      if (deps.modeSystem.getMode() === "plan-only") {
        deps.flashMessage("Already in plan mode");
        return;
      }
      deps.modeSystem.setMode("plan-only");
      deps.updateModeDisplay();
      ctx.addMessage("system", PLAN_SYSTEM_MESSAGE);
      deps.flashMessage("\u25a3 Plan mode active");
    },
  };
}
