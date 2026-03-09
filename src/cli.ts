#!/usr/bin/env node
/**
 * TeamClaw CLI entry point.
 * Commands: work, web, check, onboard, start, stop, status, config, lessons
 */

import pc from "picocolors";
import { runWork } from "./work-runner.js";
import { runWorkWithWeb } from "./work-with-web.js";
import { runWeb } from "./web/server.js";
import { runCheck } from "./check.js";
import { logger } from "./core/logger.js";

function parseGoalArg(args: string[]): { goal?: string; rest: string[] } {
  let goal: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--goal" || a === "-g") {
      const v = args[i + 1];
      if (v != null) {
        goal = v;
        i++;
      }
      continue;
    }
    if (a.startsWith("--goal=")) {
      goal = a.slice("--goal=".length);
      continue;
    }
    rest.push(a);
  }

  const trimmed = goal?.trim();
  return { goal: trimmed ? trimmed : undefined, rest };
}

function printHelp(): void {
  const title = pc.bold(pc.cyan("TeamClaw — OpenClaw team orchestration"));
  const section = (s: string) => pc.bold(pc.yellow(s));
  const cmd = (c: string) => pc.green(c);
  const desc = (d: string) => pc.dim(d);
  const exCmd = (c: string) => pc.cyan(c);

  const lines = [
    "",
    title,
    "",
    section("Usage:") + " teamclaw " + desc("<command> [options]"),
    "",
    section("Commands:"),
    "  " + cmd("work") + "       " + desc("Run work session (use --web for dashboard)"),
    "  " + cmd("web") + "        " + desc("Start Web UI (http://localhost:8000)"),
    "  " + cmd("check") + "      " + desc("Check connectivity (OpenClaw, ChromaDB)"),
    "  " + cmd("onboard") + "    " + desc("Interactive setup wizard (--install-daemon to start services in background)"),
    "  " + cmd("start") + "      " + desc("Start Web in background"),
    "  " + cmd("stop") + "       " + desc("Stop background Web"),
    "  " + cmd("status") + "     " + desc("Show status of background services"),
    "  " + cmd("config") + "     " + desc("Manage config (.env + teamclaw.config.json) safely"),
    "  " + cmd("lessons") + "    " + desc("Export lessons"),
    "",
    section("Examples:"),
    "  " + exCmd("teamclaw work") + " " + desc('--goal "Build a landing page"'),
    "  " + exCmd("teamclaw work") + " " + desc("--web"),
    "  " + exCmd("teamclaw onboard") + " " + desc("--install-daemon"),
    "  " + exCmd("teamclaw config"),
    "  " + exCmd("teamclaw config get OPENCLAW_TOKEN"),
    "  " + exCmd("teamclaw web"),
    "",
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }
  const cmd = args[0];

  if (cmd === "work") {
    if (args.includes("--web")) {
      const withoutWeb = args.filter((a) => a !== "--web");
      const parsed = parseGoalArg(withoutWeb);
      await runWorkWithWeb(parsed.goal ? [...parsed.rest, "--goal", parsed.goal] : parsed.rest);
    } else {
      const parsed = parseGoalArg(args.slice(1));
      await runWork({ args: parsed.rest, goal: parsed.goal });
    }
  } else if (cmd === "web") {
    await runWeb(args.slice(1));
  } else if (cmd === "check") {
    await runCheck(args.slice(1));
  } else if (cmd === "onboard") {
    const installDaemon = args.includes("--install-daemon");
    const { runOnboard } = await import("./onboard/index.js");
    await runOnboard({ installDaemon });
  } else if (cmd === "config") {
    const sub = args[1];
    if (!sub) {
      logger.info("Usage: teamclaw config get <KEY> [--raw] | config set <KEY> <VALUE> | config unset <KEY>");
      return;
    }

    const { getConfigValue, isSecretKey, setConfigValue, unsetConfigKey } = await import(
      "./core/configManager.js"
    );

    if (sub === "get") {
      const key = args[2];
      if (!key) {
        logger.error("Usage: teamclaw config get <KEY> [--raw]");
        process.exit(1);
      }
      const raw = args.includes("--raw");
      const res = getConfigValue(key, { raw });
      if (res.value == null) {
        logger.warn(`${key} is not set (${res.source})`);
        process.exitCode = 1;
        return;
      }
      logger.plain(res.value);
      return;
    }

    if (sub === "set") {
      const key = args[2];
      const value = args.slice(3).join(" ");
      if (!key || value.length === 0) {
        logger.error("Usage: teamclaw config set <KEY> <VALUE>");
        process.exit(1);
      }
      if (isSecretKey(key)) {
        logger.warn("This may leak into shell history; prefer `teamclaw config` interactive mode for secrets.");
      }
      const res = setConfigValue(key, value);
      if ("error" in res) {
        logger.error(res.error);
        process.exit(1);
      }
      logger.success(`Saved ${key} to ${res.source}`);
      return;
    }

    if (sub === "unset") {
      const key = args[2];
      if (!key) {
        logger.error("Usage: teamclaw config unset <KEY>");
        process.exit(1);
      }
      const res = unsetConfigKey(key);
      logger.success(`Removed ${key} from ${res.source}`);
      return;
    }

    logger.error(`Unknown subcommand: config ${sub}`);
    logger.error("Usage: teamclaw config | config get <KEY> [--raw] | config set <KEY> <VALUE> | config unset <KEY>");
    process.exit(1);
  } else if (cmd === "start") {
    const { start } = await import("./daemon/manager.js");
    const result = start({ web: true, gateway: false });
    if (result.error) {
      logger.error(result.error);
      process.exit(1);
    }
    logger.success("Web started in background.");
  } else if (cmd === "stop") {
    const { stop } = await import("./daemon/manager.js");
    stop();
    logger.success("Stopped web.");
  } else if (cmd === "status") {
    const { status } = await import("./daemon/manager.js");
    const s = status();
    const webPort = s.webPort ?? 8000;
    logger.info("Web: " + (s.web === "running" ? `running (http://localhost:${webPort})` : "stopped"));
    logger.info("Gateway: " + s.gateway);
  } else if (cmd === "lessons") {
    const { runLessonsExport } = await import("./lessons-export.js");
    await runLessonsExport(args.slice(1));
  } else {
    logger.error(`Unknown command: ${cmd}`);
    logger.error("Usage: teamclaw work | web | check | onboard | start | stop | status | config | lessons");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error(String(err));
  process.exit(1);
});
