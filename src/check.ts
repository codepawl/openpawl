/**
 * TeamClaw check - verify OpenClaw worker connectivity.
 */

import { buildTeamFromTemplate } from "./core/team-templates.js";
import { getWorkerUrlsForTeam } from "./core/config.js";
import { logger } from "./core/logger.js";
import { intro, log, note, outro, spinner } from "@clack/prompts";

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
  const canRenderSpinner = Boolean(process.stdout.isTTY && process.stderr.isTTY);
  if (canRenderSpinner) {
    intro("TeamClaw Connectivity Check");
  } else {
    logger.plain("TeamClaw connectivity check\n");
  }

  const team = buildTeamFromTemplate("game_dev");
  const workerUrls = getWorkerUrlsForTeam(team.map((b) => b.id));

  if (Object.keys(workerUrls).length === 0) {
    if (canRenderSpinner) {
      log.error("OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.");
      outro("Connectivity check failed.");
    } else {
      logger.error("❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.");
    }
    process.exit(1);
  }

  const urls = [...new Set(Object.values(workerUrls))];
  let ok = 0;
  const s = canRenderSpinner ? spinner() : null;
  if (s) {
    s.start("🌐 Connecting to OpenClaw workers...");
  }
  for (const url of urls) {
    const reachable = await pingWorker(url);
    if (reachable) {
      if (s) {
        s.message(`🌐 Worker reachable: ${url}`);
      } else {
        logger.success(`Worker reachable: ${url}`);
      }
      ok++;
    } else {
      if (s) {
        s.message(`⚠️ Worker unreachable: ${url}`);
      } else {
        logger.error(`Worker unreachable: ${url}`);
      }
    }
  }
  if (ok === urls.length) {
    if (s) {
      s.stop(`✅ All ${urls.length} worker(s) reachable.`);
      note(
        `Verified connectivity to ${urls.length} OpenClaw worker endpoint(s).`,
        "Connectivity OK",
      );
      outro("Connectivity check complete.");
    } else {
      logger.success(`All ${urls.length} worker(s) reachable.`);
    }
  } else {
    if (s) {
      s.stop(`❌ Only ${ok}/${urls.length} worker(s) reachable.`);
      note(
        [
          `Workers reachable: ${ok}/${urls.length}`,
          "",
          "Check your OpenClaw deployment and network connectivity, then retry:",
          "  teamclaw check",
        ].join("\n"),
        "Connectivity issues detected",
      );
      outro("Connectivity check failed.");
    } else {
      logger.warn(`${ok}/${urls.length} worker(s) reachable.`);
    }
    process.exit(1);
  }
}
