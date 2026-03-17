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
 * Other commands: web (start/stop/status), check, onboard, config, lessons, run
 */

import { createRequire } from "node:module";
import pc from "picocolors";
import { intro, outro } from "@clack/prompts";
import { logger } from "./core/logger.js";
import { COMMANDS, findClosestCommand, findClosestSubcommand, SUBCOMMANDS } from "./cli/fuzzy-matcher.js";
import { handleUnknownCommand, handleUnknownSubcommand } from "./cli/unknown-command.js";

function parseGoalArg(args: string[]): { goal?: string; rest: string[] } {
    let goal: string | undefined;
    const rest: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? "";
        if (a === "--goal" || a === "-g") {
            const v = args[i + 1];
            if (v != null) {
                goal = v.startsWith("@") ? v.slice(1) : v;
                i++;
            }
            continue;
        }
        if (a.startsWith("--goal=")) {
            const value = a.slice("--goal=".length);
            goal = value.startsWith("@") ? value.slice(1) : value;
            continue;
        }
        rest.push(a);
    }

    const trimmed = goal?.trim();
    return { goal: trimmed ? trimmed : undefined, rest };
}

// 4-Pillar Architecture (internal design):
//   Pillar 1 — setup/init: Guided setup wizard
//   Pillar 2 — work: Zero-config execution
//   Pillar 3 — (auto, work): Smart connection error recovery
//   Pillar 4 — (auto, work): Web Dashboard auto-start

function printHelp(): void {
    const require = createRequire(import.meta.url);
    const { version } = require("../package.json") as { version: string };

    const section = (s: string) => pc.bold(pc.yellow(s));
    const cmd = (c: string) => pc.green(c);
    const desc = (d: string) => pc.dim(d);
    const exCmd = (c: string) => pc.cyan(c);
    const pad = (s: string, w = 15) => s + " ".repeat(Math.max(1, w - s.length));

    const lines = [
        "",
        pc.bold(pc.cyan("TeamClaw")) + " — AI team orchestration" + "  " + pc.dim(`v${version}`),
        "",
        section("Usage:") + " teamclaw <command> [options]",
        "",
        section("Commands:"),
        "  " + cmd(pad("setup")) + desc("Guided setup wizard (gateway, workspace, model, team)"),
        "  " + cmd(pad("work")) + desc("Run a work session (auto-starts web dashboard)"),
        "  " + cmd(pad("config")) + desc("Manage configuration interactively"),
        "  " + cmd(pad("model")) + desc("Model selection dashboard"),
        "  " + cmd(pad("web")) + desc("Start web dashboard (default port from config)"),
        "  " + cmd(pad("check")) + desc("Check gateway connectivity"),
        "",
        "  " + cmd(pad("audit")) + desc("Export audit trail (markdown, PDF)"),
        "  " + cmd(pad("diff")) + desc("Compare runs within or across sessions"),
        "  " + cmd(pad("heatmap")) + desc("Agent utilization heatmap and bottleneck detection"),
        "  " + cmd(pad("forecast")) + desc("Estimate run cost before execution"),
        "  " + cmd(pad("replay")) + desc("Replay past sessions (list, play, diff, export)"),
        "  " + cmd(pad("agent")) + desc("Manage custom agents (add, list, remove)"),
        "  " + cmd(pad("logs")) + desc("View session and gateway logs"),
        "  " + cmd(pad("lessons")) + desc("Export lessons learned"),
        "  " + cmd(pad("memory")) + desc("Global memory: health, promote, export/import"),
        "  " + cmd(pad("profile")) + desc("Agent performance profiles: list, show, reset"),
        "  " + cmd(pad("clarity")) + desc("Check goal clarity before sprinting"),
        "  " + cmd(pad("drift")) + desc("Check goal for conflicts with past decisions"),
        "  " + cmd(pad("journal")) + desc("Decision journal: list, search, show, export"),
        "  " + cmd(pad("clean")) + desc("Remove session data (preserves global memory)"),
        "  " + cmd(pad("run openclaw")) + desc("Start OpenClaw gateway"),
        "  " + cmd(pad("demo")) + desc("Run a synthetic demo (no gateway needed)"),
        "",
        section("Work options:"),
        "  " + cmd(pad("--goal <text>")) + desc("Set goal inline, or --goal @file.md to load from file"),
        "  " + cmd(pad("--no-web")) + desc("Skip automatic web dashboard"),
        "  " + cmd(pad("--runs <N>")) + desc("Run N sessions sequentially"),
        "",
        section("Examples:"),
        "  " + exCmd("teamclaw setup") + "                          " + desc("Get started"),
        "  " + exCmd('teamclaw work --goal "Build a CLI"') + "      " + desc("Run with a goal"),
        "  " + exCmd("teamclaw model set openai/gpt-4o") + "        " + desc("Set default model"),
        "",
        desc("Run teamclaw <command> --help for details on any command."),
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
    if (args[0] === "--version" || args[0] === "-V") {
        const require = createRequire(import.meta.url);
        const { version } = require("../package.json") as { version: string };
        console.log(version);
        return;
    }
    const rawCmd = args[0] ?? "";

    // Unknown flag (starts with --)
    if (rawCmd.startsWith("--") || rawCmd.startsWith("-")) {
        logger.error(`Unknown flag "${rawCmd}". Run \`teamclaw --help\` for usage.`);
        process.exit(1);
    }

    // Case-insensitive command resolution
    const cmd = COMMANDS.find((c) => c === rawCmd.toLowerCase()) ?? rawCmd;

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
        const subCmd = args[1];
        const hasDaemonFlag = args.includes("--daemon");

        if (subCmd === "start" || hasDaemonFlag) {
            const { start } = await import("./daemon/manager.js");
            const result = start({ web: true, gateway: false });
            if (result.error) {
                logger.error(result.error);
                process.exit(1);
            }
            logger.success("Web started in background.");
            return;
        }

        if (subCmd === "stop") {
            const { stop } = await import("./daemon/manager.js");
            stop();
            logger.success("Web stopped.");
            return;
        }

        if (subCmd === "status") {
            const { status } = await import("./daemon/manager.js");
            const result = status();
            logger.plain(`Web UI: ${result.web}`);
            if (result.webPort) logger.plain(`Port: ${result.webPort}`);
            return;
        }

        // Default: foreground
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

        const subMatch = findClosestSubcommand("config", sub);
        handleUnknownSubcommand("config", sub, subMatch);

    } else if (cmd === "model") {
        const { runModelCommand } = await import("./commands/model.js");
        await runModelCommand(args.slice(1));

    } else if (cmd === "memory") {
        const { runMemoryCommand } = await import("./commands/memory.js");
        await runMemoryCommand(args.slice(1));

    } else if (cmd === "diff") {
        const { runDiffCommand } = await import("./commands/diff.js");
        await runDiffCommand(args.slice(1));

    } else if (cmd === "heatmap") {
        const { runHeatmapCommand } = await import("./commands/heatmap.js");
        await runHeatmapCommand(args.slice(1));

    } else if (cmd === "forecast") {
        const { runForecastCommand } = await import("./commands/forecast.js");
        await runForecastCommand(args.slice(1));

    } else if (cmd === "audit") {
        const { runAuditCommand } = await import("./commands/audit.js");
        await runAuditCommand(args.slice(1));

    } else if (cmd === "replay") {
        const { runReplayCommand } = await import("./commands/replay.js");
        await runReplayCommand(args.slice(1));

    } else if (cmd === "agent") {
        const { runAgentCommand } = await import("./commands/agent.js");
        await runAgentCommand(args.slice(1));

    } else if (cmd === "profile") {
        const { runProfileCommand } = await import("./commands/profile.js");
        await runProfileCommand(args.slice(1));

    } else if (cmd === "clean") {
        const { runClean } = await import("./commands/clean.js");
        await runClean(args.slice(1));

    } else if (cmd === "lessons") {
        const { runLessonsExport } = await import("./commands/lessons-export.js");
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

    } else if (cmd === "clarity") {
        const { runClarityCommand } = await import("./commands/clarity.js");
        await runClarityCommand(args.slice(1));

    } else if (cmd === "drift") {
        const { runDriftCommand } = await import("./commands/drift.js");
        await runDriftCommand(args.slice(1));

    } else if (cmd === "journal") {
        const { runJournalCommand } = await import("./commands/journal.js");
        await runJournalCommand(args.slice(1));

    } else if (cmd === "logs") {
        const { runLogs } = await import("./commands/logs.js");
        await runLogs(args.slice(1));

    } else if (cmd === "think") {
        const { runThinkCommand } = await import("./commands/think.js");
        await runThinkCommand(args.slice(1));

    } else if (cmd === "demo") {
        const canRenderSpinner = Boolean(process.stdout.isTTY && process.stderr.isTTY);
        if (canRenderSpinner) intro("TeamClaw Demo Mode");
        const { runDemo } = await import("./commands/demo.js");
        await runDemo(args.slice(1));
        if (canRenderSpinner) outro("Demo session finished.");

    } else {
        const match = findClosestCommand(rawCmd);
        handleUnknownCommand(rawCmd, match);
    }
}

main().catch((err) => {
    logger.error(String(err));
    process.exit(1);
});
