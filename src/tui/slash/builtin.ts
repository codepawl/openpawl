/**
 * Built-in slash commands: /help, /clear, /quit.
 */
import type { SlashCommand, CommandContext } from "./registry.js";
import { renderPanel, panelSection } from "../components/panel.js";

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
          const name = `/${cmd.name}`.padEnd(16);
          contentLines.push(`  ${name}${cmd.description}`);
        }
        contentLines.push("");
        contentLines.push(...panelSection("Shortcuts"));
        contentLines.push("  @file          Attach file to prompt");
        contentLines.push("  @agent         Route to specific agent");
        contentLines.push("  !command       Run shell command");
        contentLines.push("  Shift+Tab      Cycle mode (DEF/AUTO/PLAN)");
        contentLines.push("  Ctrl+P         Command palette");
        contentLines.push("  Ctrl+X + key   Leader shortcuts");
        const panel = renderPanel({ title: "Help", footer: "Press any key to close" }, contentLines);
        ctx.addMessage("system", panel.join("\n"));
      },
    },
    {
      name: "clear",
      description: "Clear the message history",
      async execute(_args: string, ctx: CommandContext) {
        ctx.addMessage("system", "Messages cleared.");
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
