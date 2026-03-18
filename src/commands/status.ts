import { intro, note, outro } from "@clack/prompts";
import { buildTeamFromRoster, buildTeamFromTemplate } from "../core/team-templates.js";
import { loadTeamConfig } from "../core/team-config.js";
import { getWorkerUrlsForTeam } from "../core/config.js";
import { getGlobalProviderManager } from "../providers/provider-factory.js";

function formatMs(n: number): string {
  return n >= 0 ? `${n}ms` : "n/a";
}

export async function runStatusCommand(): Promise<void> {
  intro("TeamClaw Status");

  // Provider status
  const mgr = getGlobalProviderManager();
  const providers = mgr.getProviders();
  const providerLines: string[] = [];
  for (const p of providers) {
    const healthy = await p.healthCheck();
    providerLines.push(`${p.name}: ${p.isAvailable() ? "available" : "unavailable"} | health=${healthy ? "ok" : "fail"}`);
  }
  if (providerLines.length === 0) {
    providerLines.push("No providers configured. Run `teamclaw setup` or set an API key env var.");
  }
  note(providerLines.join("\n"), "Providers");

  const teamConfig = await loadTeamConfig();
  const team =
    teamConfig?.roster && teamConfig.roster.length > 0
      ? buildTeamFromRoster(teamConfig.roster)
      : buildTeamFromTemplate(teamConfig?.template ?? "game_dev");
  const workerUrls = getWorkerUrlsForTeam(team.map((b) => b.id), {
    workers: teamConfig?.workers,
  });
  const botLines: string[] = [];
  for (const bot of team) {
    botLines.push(`${bot.id} (${bot.name})`);
  }
  note(botLines.join("\n"), "Roster");

  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  note(
    [
      `RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
      `Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
      `Heap Total: ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
      `CPU User: ${(cpu.user / 1000).toFixed(1)} ms`,
      `CPU System: ${(cpu.system / 1000).toFixed(1)} ms`,
    ].join("\n"),
    "System",
  );

  outro("Status complete.");
}
