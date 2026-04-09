#!/usr/bin/env node
/**
 * OpenPawl CLI entry point.
 */

import pc from "picocolors";
import { VERSION } from "./version.js";

import { logger } from "./core/logger.js";
import { COMMANDS, findClosestCommand, findClosestSubcommand } from "./cli/fuzzy-matcher.js";
import { handleUnknownCommand, handleUnknownSubcommand } from "./cli/unknown-command.js";
import { findCommand, generateHelp, generateCommandHelp, getAllCommandNames } from "./cli/command-registry.js";


function printHelp(): void {
    console.log(generateHelp());
}

async function main(): Promise<void> {
    // ── Proxy auto-detection ──────────────────────────────────────────────
    // Node's fetch (undici) ignores HTTP_PROXY/HTTPS_PROXY. On Node >= 22.8,
    // re-exec with --use-env-proxy so corporate proxies work.
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      || process.env.https_proxy || process.env.http_proxy;

    if (proxyUrl && !process.execArgv.includes("--use-env-proxy")) {
      const [major] = process.versions.node.split(".").map(Number) as [number];
      if (major >= 22) {
        // Suppress the experimental warning from undici's EnvHttpProxyAgent
        const nodeOpts = process.env.NODE_OPTIONS ?? "";
        const env = {
          ...process.env,
          NODE_OPTIONS: nodeOpts.includes("--no-warnings") ? nodeOpts : `${nodeOpts} --no-warnings=ExperimentalWarning`.trim(),
        };

        logger.plain(pc.dim(`  Proxy detected (${proxyUrl}). Routing network requests through proxy...`));

        const { spawnSync } = await import("node:child_process");
        const result = spawnSync(
          process.execPath,
          ["--use-env-proxy", ...process.argv.slice(1)],
          { stdio: "inherit", env },
        );
        process.exit(result.status ?? 1);
      } else {
        logger.warn(
          `Proxy detected (${proxyUrl}) but Node ${process.versions.node} does not support --use-env-proxy (requires >= 22).`
          + "\n  Network requests may fail. Upgrade Node or set NODE_OPTIONS=--use-env-proxy manually.",
        );
      }
    }

    const args = process.argv.slice(2);

    // ── TUI entry points (before any commander parsing) ──────────────────

    // No args → first-run check, then launch interactive TUI
    if (args.length === 0) {
        if (!process.stdin.isTTY) {
            printHelp();
            return;
        }

        // TUI handles first-run setup via SetupWizardView when no config exists
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

    // -c / --continue → launch TUI (user resumes via /sessions)
    if (args.includes("-c") || args.includes("--continue")) {
        if (!process.stdin.isTTY) {
            logger.error("Cannot resume TUI session in non-interactive mode.");
            process.exit(1);
        }
        const { launchTUI } = await import("./app/index.js");
        await launchTUI();
        return;
    }

    // ── Standard CLI flags ───────────────────────────────────────────────

    if (args[0] === "--help" || args[0] === "-h") {
        printHelp();
        return;
    }
    if (args[0] === "--version" || args[0] === "-V") {
        console.log(VERSION);
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
        if (args.includes("--reset")) {
            const { existsSync, unlinkSync } = await import("node:fs");
            const { getGlobalConfigPath } = await import("./core/global-config.js");
            const cfgPath = getGlobalConfigPath();
            if (existsSync(cfgPath)) unlinkSync(cfgPath);
        }
        const { readGlobalConfig } = await import("./core/global-config.js");
        const { runSetup } = await import("./onboard/setup-flow.js");
        const existing = readGlobalConfig();
        await runSetup({ prefill: existing ?? undefined });

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

    } else if (cmd === "settings") {
        const { runSettings } = await import("./commands/settings.js");
        await runSettings(args.slice(1));

    } else if (cmd === "uninstall") {
        const { runUninstall } = await import("./commands/uninstall.js");
        await runUninstall(args.slice(1));

    } else {
        const match = findClosestCommand(rawCmd);
        handleUnknownCommand(rawCmd, match);
    }
}

main().catch((err) => {
    logger.error(String(err));
    process.exit(1);
});
