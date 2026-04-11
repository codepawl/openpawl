/**
 * /settings command — view and edit configuration.
 * Aliases: /config, /cfg
 *
 * No args → interactive settings editor.
 * One arg → show value of that key.
 * Two+ args → set key to value.
 */
import type { SlashCommand } from "../../tui/index.js";
import { SettingsView } from "../interactive/settings-view.js";

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

function maskSensitive(key: string, value: string): string {
  if (key === "apikey" || key === "apiKey") return maskKey(value);
  return value;
}

export function createSettingsCommand(): SlashCommand {
  return {
    name: "settings",
    aliases: ["config", "cfg"],
    description: "View and edit configuration",
    args: "[key] [value]",
    async execute(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      // No args → interactive mode (if TUI available) or static list
      if (!sub) {
        if (ctx.tui) {
          const view = new SettingsView(ctx.tui, () => { /* closed */ });
          view.activate();
        } else {
          await showAllSettings(ctx);
        }
        return;
      }

      // Legacy subcommands: /settings get <key>, /settings set <key> <val>
      if (sub === "get" || sub === "help") {
        if (sub === "help" || !parts[1]) {
          await showAllSettings(ctx);
          return;
        }
        await showSetting(parts[1]!, ctx);
        return;
      }

      if (sub === "set") {
        const key = parts[1];
        const value = parts.slice(2).join(" ");
        if (!key || !value) {
          ctx.addMessage("error", "Usage: /settings set <key> <value>");
          return;
        }
        await updateSetting(key, value, ctx);
        return;
      }

      // Single arg → show value
      if (parts.length === 1) {
        await showSetting(sub, ctx);
        return;
      }

      // Two+ args → set value
      await updateSetting(sub, parts.slice(1).join(" "), ctx);
    },
  };
}

async function showAllSettings(ctx: { addMessage: (role: string, content: string) => void }): Promise<void> {
  const { getConfigValue } = await import("../../core/configManager.js");
  const keys = ["provider", "model", "apikey", "mode", "maxCycles", "temperature", "dashboardPort"];

  const lines = ["\u2699 Settings\n"];
  for (const key of keys) {
    const result = getConfigValue(key, { raw: false });
    const val = result.value != null ? maskSensitive(key, String(result.value)) : "(not set)";
    lines.push(`  ${key.padEnd(18)} ${val}`);
  }
  lines.push("");
  lines.push("Edit: /settings <key> <value>");
  ctx.addMessage("system", lines.join("\n"));
}

async function showSetting(key: string, ctx: { addMessage: (role: string, content: string) => void }): Promise<void> {
  const { getConfigValue } = await import("../../core/configManager.js");
  const result = getConfigValue(key, { raw: false });
  if (result.value == null) {
    ctx.addMessage("system", `${key} is not set (${result.source})`);
  } else {
    ctx.addMessage("system", `${key} = ${maskSensitive(key, String(result.value))} (${result.source})`);
  }
}

async function updateSetting(key: string, value: string, ctx: { addMessage: (role: string, content: string) => void }): Promise<void> {
  const { setConfigValue } = await import("../../core/configManager.js");
  const result = setConfigValue(key, value);
  if ("error" in result) {
    ctx.addMessage("error", result.error);
  } else {
    const { ICONS } = await import("../../tui/constants/icons.js");
    ctx.addMessage("system", `${ICONS.success} ${key} updated to ${maskSensitive(key, value)} (${result.source})`);
  }
}
