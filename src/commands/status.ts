import { intro, note, outro } from "@clack/prompts";
import { runGatewayHealthCheck } from "../core/health.js";
import { buildTeamFromRoster, buildTeamFromTemplate } from "../core/team-templates.js";
import { loadTeamConfig } from "../core/team-config.js";
import { getWorkerUrlsForTeam } from "../core/config.js";
import { createWorkerAdapter } from "../adapters/worker-adapter.js";

function formatMs(n: number): string {
  return n >= 0 ? `${n}ms` : "n/a";
}

export async function runStatusCommand(): Promise<void> {
  intro("TeamClaw Status");
  const health = await runGatewayHealthCheck();

  note(
    [
      `URL: ${health.gatewayUrl}`,
      `Protocol: ${health.protocol.toUpperCase()}`,
      `Latency: ${formatMs(health.latency)}`,
      `Auth: ${health.authStatus}`,
      `Overall: ${health.status}`,
      "",
      ...health.checks.map((c) => `- ${c.name}: ${c.level} (${c.message})`),
      ...(health.tip ? ["", health.tip] : []),
    ].join("\n"),
    "Gateway",
  );

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
    const adapter = createWorkerAdapter(bot, workerUrls);
    const available = await adapter.healthCheck();
    botLines.push(
      `${bot.id} (${bot.name}) | model=${process.env["OPENCLAW_MODEL"] ?? "(not set)"} | ${
        available ? "available" : "unreachable"
      }`,
    );
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

