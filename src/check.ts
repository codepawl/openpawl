/**
 * TeamClaw check - verify OpenClaw worker connectivity.
 */

import { buildTeamFromTemplate } from "./core/team-templates.js";
import { getWorkerUrlsForTeam } from "./core/config.js";
import { logger } from "./core/logger.js";

async function pingWorker(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runCheck(_args: string[]): Promise<void> {
  const team = buildTeamFromTemplate("game_dev");
  const workerUrls = getWorkerUrlsForTeam(team.map((b) => b.id));

  logger.plain("TeamClaw connectivity check\n");

  if (Object.keys(workerUrls).length === 0) {
    logger.error("❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.");
    process.exit(1);
  }

  const urls = [...new Set(Object.values(workerUrls))];
  let ok = 0;
  for (const url of urls) {
    const reachable = await pingWorker(url);
    if (reachable) {
      logger.success(`Worker reachable: ${url}`);
      ok++;
    } else {
      logger.error(`Worker unreachable: ${url}`);
    }
  }

  logger.plain("");
  if (ok === urls.length) {
    logger.success(`All ${urls.length} worker(s) reachable.`);
  } else {
    logger.warn(`${ok}/${urls.length} worker(s) reachable.`);
    process.exit(1);
  }
}
