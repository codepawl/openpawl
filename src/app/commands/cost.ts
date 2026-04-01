/**
 * /cost command — show session cost and token usage.
 */
import type { SlashCommand } from "../../tui/index.js";
import type { SessionManager } from "../session.js";

export function createCostCommand(session: SessionManager): SlashCommand {
  return {
    name: "cost",
    description: "Show session cost and token usage",
    async execute(_args, ctx) {
      const stats = session.getStats();
      const elapsed = ((Date.now() - stats.startedAt) / 1000).toFixed(0);

      const lines = [
        `**Session:** ${stats.sessionId}`,
        `**Duration:** ${elapsed}s`,
        `**Messages:** ${stats.messageCount}`,
        `**Work runs:** ${stats.workRunCount}`,
      ];
      if (stats.lastGoal) {
        lines.push(`**Last goal:** ${stats.lastGoal}`);
      }

      try {
        const { getProviderManager } = await import("../../proxy/ProxyService.js");
        const pm = getProviderManager();
        if (pm) {
          const providerStats = pm.getStats();
          const entries = Object.entries(providerStats).filter(([k]) => k !== "fallbacksTriggered");
          if (entries.length > 0) {
            lines.push("", "**Provider stats:**");
            for (const [name, stat] of entries) {
              if (typeof stat === "object" && stat !== null) {
                const s = stat as { requests: number; failures: number };
                lines.push(`  ${name}: ${s.requests} requests, ${s.failures} failures`);
              }
            }
          }
        }
      } catch {
        // Provider stats not available
      }

      ctx.addMessage("system", lines.join("\n"));
    },
  };
}
