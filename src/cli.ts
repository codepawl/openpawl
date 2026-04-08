#!/usr/bin/env node
/**
 * OpenPawl CLI entry point.
 *
 * 4-Pillar Architecture:
 *   Pillar 1 — `openpawl setup` / `openpawl init`  : Dedicated setup phase
 *   Pillar 2 — `openpawl work`                     : Zero-config execution
 *   Pillar 3 — Smart error recovery (inside work)  : Structured diagnostics
 *   Pillar 4 — Web Dashboard auto-start on `work`  : Background dashboard
 *
 * Other commands: web (start/stop/status), check, onboard, config, lessons, run
 */

import { createRequire } from "node:module";
import { intro, outro } from "@clack/prompts";
import { logger } from "./core/logger.js";
import { COMMANDS, findClosestCommand, findClosestSubcommand } from "./cli/fuzzy-matcher.js";
import { handleUnknownCommand, handleUnknownSubcommand } from "./cli/unknown-command.js";
import { findCommand, generateHelp, generateCommandHelp, getAllCommandNames } from "./cli/command-registry.js";

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
    console.log(generateHelp());
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // ── TUI entry points (before any commander parsing) ──────────────────

    // No args → first-run check, then launch interactive TUI
    if (args.length === 0) {
        if (!process.stdin.isTTY) {
            printHelp();
            return;
        }

        // Check if first-run setup is needed
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const configPath = join(homedir(), ".openpawl", "config.json");

        if (!existsSync(configPath)) {
            const { handleFirstRun } = await import("./onboard/index.js");
            const result = await handleFirstRun();
            if (result.isErr()) {
                if (result.error.type === "cancelled") return;
                logger.error(result.error.type === "not_interactive"
                    ? result.error.message
                    : `Setup failed: ${result.error.type}`);
                return;
            }
        }

        const { launchTUI } = await import("./app/index.js");
        await launchTUI();
        return;
    }

    // -p / --print <prompt> → non-interactive print mode
    const printIdx = args.findIndex((a) => a === "-p" || a === "--print");
    if (printIdx !== -1) {
        const prompt = args[printIdx + 1];
        if (!prompt) {
            logger.error("Usage: openpawl -p <prompt>");
            process.exit(1);
        }
        const { runPrintMode } = await import("./app/index.js");
        await runPrintMode(prompt);
        return;
    }

    // -c / --continue → resume last TUI session
    if (args.includes("-c") || args.includes("--continue")) {
        if (!process.stdin.isTTY) {
            logger.error("Cannot resume TUI session in non-interactive mode.");
            process.exit(1);
        }
        const { launchTUI } = await import("./app/index.js");
        await launchTUI({ resume: true });
        return;
    }

    // ── Standard CLI flags ───────────────────────────────────────────────

    if (args[0] === "--help" || args[0] === "-h") {
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
        logger.error(`Unknown flag "${rawCmd}". Run \`openpawl --help\` for usage.`);
        process.exit(1);
    }

    // Case-insensitive command resolution (use both old COMMANDS array and new registry)
    const allNames = getAllCommandNames();
    const cmd = allNames.find((c) => c === rawCmd.toLowerCase()) ?? COMMANDS.find((c) => c === rawCmd.toLowerCase()) ?? rawCmd;

    // Per-command --help: openpawl <command> --help
    if (args.includes("--help") || args.includes("-h")) {
        const cmdDef = findCommand(cmd);
        if (cmdDef) {
            console.log(generateCommandHelp(cmdDef));
            return;
        }
    }

    // -------------------------------------------------------------------------
    // Pillar 1: openpawl setup
    // -------------------------------------------------------------------------
    if (cmd === "setup" || cmd === "init") {
        // --reset flag: delete existing config, start fresh
        if (args.includes("--reset")) {
            const { existsSync, unlinkSync } = await import("node:fs");
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");
            const configPath = join(homedir(), ".openpawl", "config.json");
            if (existsSync(configPath)) {
                unlinkSync(configPath);
                logger.success("Config reset.");
            }
        }
        const { handleFirstRun } = await import("./onboard/index.js");
        const result = await handleFirstRun();
        if (result.isErr() && result.error.type !== "cancelled") {
            logger.error(`Setup failed: ${result.error.type}`);
        }

    // -------------------------------------------------------------------------
    // Pillar 2 + 3 + 4: openpawl work — zero-config, auto-web, smart recovery
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
            const { isMockLlmEnabled } = await import("./core/mock-llm.js");
            const mockLabel = isMockLlmEnabled() ? " [mock mode]" : "";
            intro(`OpenPawl Work Session${mockLabel}`);
        }

        const { runWork } = await import("./work-runner.js");
        // Pillar 2: pass noWeb flag so work-runner never prompts for infrastructure
        await runWork({
            args: parsed.rest,
            goal: parsed.goal,
            openDashboard: !hasNoWebFlag,
            noWeb: hasNoWebFlag,
        });

    } else if (cmd === "web") {
        const subCmd = args[1];
        const hasDaemonFlag = args.includes("--daemon");

        if (subCmd === "start" || hasDaemonFlag) {
            const { isDashboardRunning } = await import("./work-runner/dashboard-setup.js");
            const { start, status: daemonStatus } = await import("./daemon/manager.js");
            const { readGlobalConfigWithDefaults } = await import("./core/global-config.js");
            const port = readGlobalConfigWithDefaults().dashboardPort ?? 9001;

            // Check if already running
            const running = await isDashboardRunning(port);
            if (running) {
                logger.success(`Dashboard already running at http://localhost:${port}`);
                return;
            }

            const result = start({ web: true, gateway: false, webPort: port });
            if (result.error) {
                logger.error(result.error);
                process.exit(1);
            }
            const actualPort = daemonStatus().webPort ?? port;
            logger.success(`Dashboard running at http://localhost:${actualPort}`);
            return;
        }

        if (subCmd === "stop") {
            const { stop } = await import("./daemon/manager.js");
            stop();
            logger.success("Dashboard stopped.");
            return;
        }

        if (subCmd === "status") {
            const { status } = await import("./daemon/manager.js");
            const { isDashboardRunning } = await import("./work-runner/dashboard-setup.js");
            const result = status();
            if (result.web === "running" && result.webPort) {
                const healthy = await isDashboardRunning(result.webPort);
                if (healthy) {
                    logger.plain(`Running at http://localhost:${result.webPort} (PID from daemon state)`);
                } else {
                    logger.plain(`Daemon state says running on port ${result.webPort} but health check failed`);
                }
            } else {
                logger.plain("Not running — start with: openpawl web start");
            }
            return;
        }

        if (subCmd === "open") {
            const { isDashboardRunning } = await import("./work-runner/dashboard-setup.js");
            const { readGlobalConfigWithDefaults } = await import("./core/global-config.js");
            const port = readGlobalConfigWithDefaults().dashboardPort ?? 9001;

            // Start if not running
            let running = await isDashboardRunning(port);
            if (!running) {
                const { start } = await import("./daemon/manager.js");
                const result = start({ web: true, gateway: false, webPort: port });
                if (result.error) {
                    logger.error(result.error);
                    process.exit(1);
                }
                // Wait for it to come up
                for (let i = 0; i < 10; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    running = await isDashboardRunning(port);
                    if (running) break;
                }
                if (running) {
                    logger.success(`Dashboard started at http://localhost:${port}`);
                } else {
                    logger.warn(`Dashboard may still be starting at http://localhost:${port}`);
                }
            }

            try {
                const { default: open } = await import("open");
                await open(`http://localhost:${port}`);
                logger.success(`Opened http://localhost:${port} in browser`);
            } catch {
                logger.plain(`Open http://localhost:${port} in your browser`);
            }
            return;
        }

        // Default: foreground
        const canRenderSpinner = Boolean(
            process.stdout.isTTY && process.stderr.isTTY,
        );
        if (canRenderSpinner) {
            intro("OpenPawl Web Server");
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
                logger.error("Usage: openpawl config get <KEY> [--raw]");
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
                logger.error("Usage: openpawl config set <KEY> <VALUE>");
                process.exit(1);
            }
            if (isSecretKey(key)) {
                logger.warn(
                    "This may leak into shell history; prefer `openpawl config` interactive mode for secrets.",
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
                logger.error("Usage: openpawl config unset <KEY>");
                process.exit(1);
            }
            const res = unsetConfigKey(key);
            logger.success(`Removed ${key} from ${res.source}`);
            return;
        }

        const subMatch = findClosestSubcommand("config", sub);
        handleUnknownSubcommand("config", sub, subMatch);

    } else if (cmd === "model" || cmd === "models") {
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

    } else if (cmd === "clarity") {
        const { runClarityCommand } = await import("./commands/clarity.js");
        await runClarityCommand(args.slice(1));

    } else if (cmd === "drift") {
        const { runDriftCommand } = await import("./commands/drift.js");
        await runDriftCommand(args.slice(1));

    } else if (cmd === "journal") {
        const { runJournalCommand } = await import("./commands/journal.js");
        await runJournalCommand(args.slice(1));

    } else if (cmd === "standup") {
        const { runStandupCommand } = await import("./commands/standup.js");
        await runStandupCommand(args.slice(1));

    } else if (cmd === "logs") {
        const { runLogs } = await import("./commands/logs.js");
        await runLogs(args.slice(1));

    } else if (cmd === "think") {
        const { runThinkCommand } = await import("./commands/think.js");
        await runThinkCommand(args.slice(1));

    } else if (cmd === "think-worker") {
        const jobId = args[1];
        if (!jobId) process.exit(1);
        const { runAsyncThinkWorker } = await import("./think/async-worker.js");
        await runAsyncThinkWorker(jobId);

    } else if (cmd === "handoff") {
        const { runHandoffCommand } = await import("./commands/handoff.js");
        await runHandoffCommand(args.slice(1));

    } else if (cmd === "score") {
        const { runScoreCommand } = await import("./commands/score.js");
        await runScoreCommand(args.slice(1));

    } else if (cmd === "update") {
        const { runUpdateCommand } = await import("./commands/update.js");
        await runUpdateCommand(args.slice(1));

    } else if (cmd === "templates" || cmd === "template") {
        const { runTemplatesCommand } = await import("./commands/templates.js");
        await runTemplatesCommand(args.slice(1));

    } else if (cmd === "cache") {
        const { runCacheCommand } = await import("./commands/cache.js");
        await runCacheCommand(args.slice(1));

    } else if (cmd === "providers") {
        const { runProvidersCommand } = await import("./commands/providers.js");
        await runProvidersCommand(args.slice(1));

    } else if (cmd === "sessions" || cmd === "session") {
        const { runSessionsCommand } = await import("./commands/sessions.js");
        await runSessionsCommand(args.slice(1));

    } else if (cmd === "chat") {
        const { runChatCommand } = await import("./commands/chat.js");
        await runChatCommand(args.slice(1));

    } else if (cmd === "demo") {
        const { runDemo } = await import("./commands/demo.js");
        await runDemo(args.slice(1));

    } else {
        const match = findClosestCommand(rawCmd);
        handleUnknownCommand(rawCmd, match);
    }
}

main().catch((err) => {
    logger.error(String(err));
    process.exit(1);
});
