/**
 * Built-in slash commands: /help, /clear, /quit.
 */
import type { SlashCommand, CommandContext } from "./registry.js";
import { renderPanel, panelSection } from "../components/panel.js";
import { labelValue } from "../primitives/columns.js";

export function createBuiltinCommands(
  getRegistry: () => { getAll: () => SlashCommand[] },
): SlashCommand[] {
  return [
    {
      name: "help",
      aliases: ["h", "?"],
      description: "Show available commands",
      async execute(_args: string, ctx: CommandContext) {
        const commands = getRegistry().getAll();
        const contentLines = [...panelSection("Commands")];
        for (const cmd of commands) {
          contentLines.push(labelValue(`/${cmd.name}`, cmd.description, { labelWidth: 16, gap: 1 }));
        }
        contentLines.push("");
        contentLines.push(...panelSection("Shortcuts"));
        contentLines.push(labelValue("@file", "Attach file to prompt", { labelWidth: 16, gap: 1 }));
        contentLines.push(labelValue("@agent", "Route to specific agent", { labelWidth: 16, gap: 1 }));
        contentLines.push(labelValue("!command", "Run shell command", { labelWidth: 16, gap: 1 }));
        contentLines.push(labelValue("Shift+Tab", "Cycle mode (DEF/AUTO/PLAN)", { labelWidth: 16, gap: 1 }));
        contentLines.push(labelValue("Ctrl+P", "Command palette", { labelWidth: 16, gap: 1 }));
        contentLines.push(labelValue("Ctrl+X + key", "Leader shortcuts", { labelWidth: 16, gap: 1 }));
        const panel = renderPanel({ title: "Help", footer: "Press any key to close" }, contentLines);
        ctx.addMessage("system", panel.join("\n"));
      },
    },
    {
      name: "clear",
      description: "Clear the message history",
      async execute(_args: string, ctx: CommandContext) {
        ctx.clearMessages();
        ctx.requestRender();
      },
    },
    {
      name: "quit",
      aliases: ["exit", "q"],
      description: "Exit the application",
      async execute(_args: string, ctx: CommandContext) {
        ctx.exit();
      },
    },
  ];
}
