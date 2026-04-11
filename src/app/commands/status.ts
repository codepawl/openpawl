/**
 * /status command — show provider and team status.
 */
import type { SlashCommand } from "../../tui/index.js";
import { formatBytes } from "../../utils/formatters.js";

export function createStatusCommand(): SlashCommand {
  return {
    name: "status",
    aliases: ["s"],
    description: "Show provider and system status",
    async execute(_args, ctx) {
      const { getGlobalProviderManager } = await import("../../providers/provider-factory.js");
      const { loadTeamConfig } = await import("../../core/team-config.js");
      const { buildTeamFromRoster, buildTeamFromTemplate } = await import("../../core/team-templates.js");

      const pm = await getGlobalProviderManager();
      const providers = pm.getProviders();
      const lines: string[] = ["**Providers:**"];
      for (const p of providers) {
        const ok = await p.healthCheck().catch(() => false);
        lines.push(`  ${p.name}: ${p.isAvailable() ? "available" : "unavailable"} | health=${ok ? "ok" : "fail"}`);
      }
      if (providers.length === 0) {
        lines.push("  No providers configured. Run `openpawl setup`.");
      }

      const tc = await loadTeamConfig().catch(() => null);
      const team = tc?.roster?.length
        ? buildTeamFromRoster(tc.roster)
        : buildTeamFromTemplate(tc?.template ?? "maker_reviewer");
      lines.push("", "**Team:**");
      for (const bot of team) {
        lines.push(`  ${bot.id} (${bot.name})`);
      }

      const mem = process.memoryUsage();
      lines.push("", "**System:**");
      lines.push(`  RSS: ${formatBytes(mem.rss)}`);
      lines.push(`  Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`);

      ctx.addMessage("system", lines.join("\n"));
    },
  };
}
