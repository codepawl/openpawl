/**
 * /plan and /execute commands — mode toggles for plan-only workflow.
 *
 * /plan (no args) → enter plan-only mode: read-only tools, system prompt for exploring/planning.
 * /execute (no args) → exit plan mode: capture last plan, inject as fresh context, switch to default.
 */
import type { SlashCommand } from "../../tui/index.js";
import type { ModeSystem } from "../../tui/keybindings/mode-system.js";
import type { Session } from "../../session/session.js";

export interface PlanCommandDeps {
  modeSystem: ModeSystem;
  updateModeDisplay: () => void;
  getSession: () => Session | null;
  flashMessage: (msg: string) => void;
}

const PLAN_SYSTEM_MESSAGE = [
  "**Plan mode active.** You are now in read-only exploration mode.",
  "",
  "Your job: explore the codebase and create a detailed plan.",
  "You can read files, list directories, and search — but you cannot modify anything.",
  "",
  "When your plan is ready, the user will run `/execute` to switch to execution mode.",
].join("\n");

export function createPlanCommand(deps: PlanCommandDeps): SlashCommand {
  return {
    name: "plan",
    description: "Enter plan-only mode (read-only tools)",
    async execute(_args, ctx) {
      if (deps.modeSystem.getMode() === "plan-only") {
        deps.flashMessage("Already in plan mode");
        return;
      }
      deps.modeSystem.setMode("plan-only");
      deps.updateModeDisplay();
      ctx.addMessage("system", PLAN_SYSTEM_MESSAGE);
      deps.flashMessage("▣ Plan mode active");
    },
  };
}

export function createExecuteCommand(deps: PlanCommandDeps): SlashCommand {
  return {
    name: "execute",
    aliases: ["exec"],
    description: "Exit plan mode and execute the plan",
    async execute(_args, ctx) {
      if (deps.modeSystem.getMode() !== "plan-only") {
        ctx.addMessage("system", "Not in plan mode. Use `/plan` first to enter plan-only mode.");
        return;
      }

      // Capture the last assistant message as the plan
      const session = deps.getSession();
      const messages = session?.messages ?? [];
      const lastPlan = [...messages].reverse().find((m) => m.role === "assistant");

      if (!lastPlan?.content) {
        ctx.addMessage("system", "No plan found. Chat with the agent first to create a plan, then run `/execute`.");
        return;
      }

      // Switch back to default mode
      deps.modeSystem.setMode("default");
      deps.updateModeDisplay();

      // Show plan preview and inject as execution context
      const preview = lastPlan.content.length > 500
        ? lastPlan.content.slice(0, 500) + "..."
        : lastPlan.content;
      ctx.addMessage("system", `**Plan captured.** Switching to execution mode.\n\n---\n${preview}\n---\n\nExecute the plan above. Use all available tools to implement it.`);
      deps.flashMessage("▣ Plan mode ended — executing");
    },
  };
}
