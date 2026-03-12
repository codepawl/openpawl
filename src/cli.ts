#!/usr/bin/env node
/**
 * TeamClaw CLI entry point.
 *
 * 4-Pillar Architecture:
 *   Pillar 1 — `teamclaw setup` / `teamclaw init`  : Dedicated setup phase
 *   Pillar 2 — `teamclaw work`                     : Zero-config execution
 *   Pillar 3 — Smart error recovery (inside work)  : Structured diagnostics
 *   Pillar 4 — Web Dashboard auto-start on `work`  : Background dashboard
 *
 * Other commands: web, check, onboard, start, stop, status, config, lessons, run
 */

import pc from "picocolors";
import { intro, outro } from "@clack/prompts";
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
        section("4-Pillar Architecture:"),
        "  " +
            pc.bold("Pillar 1") +
            " — " +
            cmd("setup") +
            " / " +
            cmd("init") +
            "  " +
            desc("Guided setup wizard — configure gateway, save config"),
        "  " +
            pc.bold("Pillar 2") +
            " — " +
            cmd("work") +
            "            " +
            desc("Zero-config execution — reads saved config, no infrastructure prompts"),
        "  " +
            pc.bold("Pillar 3") +
            " — " +
            desc("(auto, inside work) Smart connection error recovery with actionable steps"),
        "  " +
            pc.bold("Pillar 4") +
            " — " +
            desc("(auto, inside work) Web Dashboard starts in background — use --no-web to disable"),
        "",
        section("Usage:") + " teamclaw " + desc("<command> [options]"),
        "",
        section("Setup & Configuration:"),
        "  " + cmd("setup") + "      " + desc("Run the interactive setup wizard (saves gateway config)"),
        "  " + cmd("init") + "       " + desc("Alias for setup"),
        "  " + cmd("onboard") + "    " + desc("Full interactive onboarding (team roster, templates, daemon)"),
        "  " + cmd("config") + "     " + desc("Manage config (.env + teamclaw.config.json) safely"),
        "",
        section("Work Session:"),
        "  " + cmd("work") + "       " + desc("Run a work session (reads config, auto-starts web dashboard)"),
        "  " + cmd("web") + "        " + desc("Start Web UI manually (http://localhost:8000)"),
        "  " + cmd("check") + "      " + desc("Check connectivity (OpenClaw workers)"),
        "",
        section("Background Services:"),
        "  " + cmd("start") + "      " + desc("Start Web in background"),
        "  " + cmd("stop") + "       " + desc("Stop background Web"),
        "  " + cmd("status") + "     " + desc("Show status of background services"),
        "",
        section("Utilities:"),
        "  " + cmd("lessons") + "    " + desc("Export lessons"),
        "  " + cmd("run") + "        " + desc("Run OpenClaw gateway (run openclaw --port 8001)"),
        "",
        section("work flags:"),
        "  " + pc.green("--goal") + " " + desc('"Your goal"     Set work goal without prompting'),
        "  " + pc.green("--no-web") + "            " + desc("Disable automatic web dashboard startup"),
        "  " + pc.green("--runs") + " " + desc("<N>            Number of work sessions to run sequentially"),
        "  " + pc.dim("(infra flags like --port/--discover are setup-time concerns; use `teamclaw setup`)"),
        "",
        section("Examples:"),
        "  " + exCmd("teamclaw setup"),
        "  " + exCmd("teamclaw work"),
        "  " + exCmd("teamclaw work") + " " + desc('--goal "Build a landing page"'),
        "  " + exCmd("teamclaw work") + " " + desc("--no-web"),
        "  " + exCmd("teamclaw config"),
        "  " + exCmd("teamclaw config get OPENCLAW_TOKEN"),
        "  " + exCmd("teamclaw web"),
        "  " + exCmd("teamclaw web -p 9000"),
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

    // -------------------------------------------------------------------------
    // Pillar 1: teamclaw setup
    // -------------------------------------------------------------------------
    if (cmd === "setup" || cmd === "init") {
        const { runSetup } = await import("./commands/setup.js");
        await runSetup();

    // -------------------------------------------------------------------------
    // Pillar 2 + 3 + 4: teamclaw work — zero-config, auto-web, smart recovery
    // -------------------------------------------------------------------------
    } else if (cmd === "work") {
        const commandArgs = args.slice(1);
        // Pillar 4: --no-web flag
        const hasNoWebFlag = commandArgs.includes("--no-web");
        // Strip legacy --web / --no-dashboard flags (kept for compat, no longer meaningful)
        const workArgs = commandArgs.filter(
            (a) => a !== "--web" && a !== "--no-dashboard",
        );
        const parsed = parseGoalArg(workArgs);
        const canRenderSpinner = Boolean(
            process.stdout.isTTY && process.stderr.isTTY,
        );

        if (canRenderSpinner) {
            intro("TeamClaw Work Session");
        }

        const { runWork } = await import("./work-runner.js");
        // Pillar 2: pass noWeb flag so work-runner never prompts for infrastructure
        await runWork({
            args: parsed.rest,
            goal: parsed.goal,
            openDashboard: !hasNoWebFlag,
            noWeb: hasNoWebFlag,
        });

        if (canRenderSpinner) {
            outro("Work session finished.");
        }

    } else if (cmd === "web") {
        const canRenderSpinner = Boolean(
            process.stdout.isTTY && process.stderr.isTTY,
        );
        if (canRenderSpinner) {
            intro("TeamClaw Web Server");
        }
        const { runWeb } = await import("./web/server.js");
        await runWeb(args.slice(1));
        if (canRenderSpinner) {
            outro("Web server ready.");
        }

    } else if (cmd === "check") {
        const { runCheck } = await import("./check.js");
        await runCheck(args.slice(1));

    } else if (cmd === "onboard") {
        const installDaemon = args.includes("--install-daemon");
        const { runOnboard } = await import("./onboard/index.js");
        await runOnboard({ installDaemon });

    } else if (cmd === "config") {
        const sub = args[1];
        if (!sub) {
            const { runConfigDashboard } = await import("./commands/config.js");
            await runConfigDashboard();
            return;
        }

        const { getConfigValue, isSecretKey, setConfigValue, unsetConfigKey } =
            await import("./core/configManager.js");

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
                logger.warn(
                    "This may leak into shell history; prefer `teamclaw config` interactive mode for secrets.",
                );
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
        logger.error(
            "Usage: teamclaw config | config get <KEY> [--raw] | config set <KEY> <VALUE> | config unset <KEY>",
        );
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
        const { runStatusCommand } = await import("./commands/status.js");
        await runStatusCommand();

    } else if (cmd === "lessons") {
        const { runLessonsExport } = await import("./lessons-export.js");
        await runLessonsExport(args.slice(1));

    } else if (cmd === "run") {
        const runArgs = args.slice(1);
        if (!runArgs[0] || runArgs[0] === "--help" || runArgs[0] === "-h") {
            logger.plain("Usage: teamclaw run openclaw [--port PORT]");
            logger.plain("");
            logger.plain("Start the OpenClaw gateway.");
            logger.plain("");
            logger.plain("Examples:");
            logger.plain("  teamclaw run openclaw            # interactive (auto-detect port)");
            logger.plain("  teamclaw run openclaw --port 9000");
            return;
        }
        if (runArgs[0] === "openclaw" || runArgs[0] === "gateway") {
            const portIndex = runArgs.indexOf("--port");
            const explicitPort =
                portIndex !== -1 && runArgs[portIndex + 1]
                    ? runArgs[portIndex + 1]
                    : undefined;
            const { startOpenclawGateway } = await import("./commands/run-openclaw.js");
            await startOpenclawGateway({ port: explicitPort });
        } else {
            logger.error(`Unknown run target: ${runArgs[0]}`);
            logger.error("Usage: teamclaw run openclaw [--port PORT]");
            process.exit(1);
        }

    } else {
        logger.error(`Unknown command: ${cmd}`);
        logger.error(
            "Run `teamclaw --help` for usage. Key commands: setup, work, config, web, check, status.",
        );
        process.exit(1);
    }
}

main().catch((err) => {
    logger.error(String(err));
    process.exit(1);
});
