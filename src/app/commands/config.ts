/**
 * /config command — get/set configuration values.
 */
import type { SlashCommand } from "../../tui/index.js";

export function createConfigCommand(): SlashCommand {
  return {
    name: "config",
    description: "Get or set configuration values",
    args: "get|set <key> [value]",
    async execute(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      if (!sub || sub === "help") {
        ctx.addMessage("system", [
          "Usage:",
          "  /config get <key>         Show a config value",
          "  /config set <key> <value> Set a config value",
          "  /config get model         Show current model",
        ].join("\n"));
        return;
      }

      const { getConfigValue, setConfigValue } = await import("../../core/configManager.js");

      if (sub === "get") {
        const key = parts[1];
        if (!key) { ctx.addMessage("error", "Usage: /config get <key>"); return; }
        const result = getConfigValue(key, { raw: false });
        if (result.value == null) {
          ctx.addMessage("system", `${key} is not set (${result.source})`);
        } else {
          ctx.addMessage("system", `${key} = ${result.value} (${result.source})`);
        }
        return;
      }

      if (sub === "set") {
        const key = parts[1];
        const value = parts.slice(2).join(" ");
        if (!key || !value) { ctx.addMessage("error", "Usage: /config set <key> <value>"); return; }
        const result = setConfigValue(key, value);
        if ("error" in result) {
          ctx.addMessage("error", result.error);
        } else {
          ctx.addMessage("system", `Saved ${key} to ${result.source}`);
        }
        return;
      }

      ctx.addMessage("error", `Unknown config subcommand: ${sub}. Use /config help.`);
    },
  };
}
