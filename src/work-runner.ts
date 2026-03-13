/**
 * Work Runner - Team orchestration sessions with lesson learning.
 */

import { createTeamOrchestration } from "./core/simulation.js";
import {
    buildTeamFromRoster,
    buildTeamFromTemplate,
} from "./core/team-templates.js";
import {
    getWorkerUrlsForTeam,
    setSessionConfig,
    clearSessionConfig,
} from "./core/config.js";
import { getDefaultGoal } from "./core/configManager.js";
import { loadTeamConfig } from "./core/team-config.js";
import { VectorMemory } from "./core/knowledge-base.js";
import { PostMortemAnalyst } from "./agents/analyst.js";
import { RetrospectiveAgent } from "./agents/retrospective.js";
import {
    CONFIG,
    setOpenClawWorkerUrl,
    setOpenClawHttpUrl,
    setOpenClawToken,
    setOpenClawChatEndpoint,
    setOpenClawModel,
} from "./core/config.js";
import { provisionOpenClaw } from "./core/provisioning.js";
import {
    validateStartup,
} from "./core/startup-validation.js";
import { appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    clearSessionWarnings,
    getSessionWarnings,
} from "./core/session-warnings.js";
import { logger, setDebugMode, isDebugMode } from "./core/logger.js";
import { ensureWorkspaceDir } from "./core/workspace-fs.js";
import type { MemoryBackend } from "./core/config.js";
import type { GraphState } from "./core/graph-state.js";
import type { BotDefinition } from "./core/bot-definitions.js";
import { log as clackLog, note, spinner, select, text, cancel, isCancel } from "@clack/prompts";
import pc from "picocolors";
import { runGatewayHealthCheck } from "./core/health.js";
import { isPortInUse, cleanupManagedGateway, setupGatewayCleanupHandlers } from "./commands/run-openclaw.js";
import { readGlobalConfig, readGlobalConfigWithDefaults } from "./core/global-config.js";
import { rotateAndCreateSessionLog } from "./utils/log-rotation.js";
import { getTrafficController } from "./core/traffic-control.js";
import { promptPath } from "./utils/path-autocomplete.js";

let DEBUG_LOG_PATH = "";

function getBotName(botId: string, team: BotDefinition[]): string {
    const bot = team.find((b) => b.id === botId);
    return bot?.name ?? botId;
}

function log(level: "info" | "warn" | "error", msg: string): void {
    const levelUp = level.toUpperCase() as "INFO" | "WARN" | "ERROR";
    if (level === "info") logger.info(msg);
    else if (level === "warn") logger.warn(msg);
    else logger.error(msg);
    appendFile(
        path.join(CONFIG.workspaceDir, "work_history.log"),
        logger.plainLine(levelUp, msg) + "\n",
    ).catch(() => {});
}

const SUPPORTED_GOAL_EXTENSIONS = [".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".rst", ".adoc"];

function resolveGoalFromFile(input: string, workspaceDir?: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    
    const hasValidExtension = SUPPORTED_GOAL_EXTENSIONS.some(ext => trimmed.endsWith(ext));
    if (!hasValidExtension) return null;
    
    const searchPaths: string[] = [];
    
    if (path.isAbsolute(trimmed)) {
        searchPaths.push(trimmed);
    } else {
        if (workspaceDir) {
            searchPaths.push(path.resolve(workspaceDir, trimmed));
        }
        searchPaths.push(path.resolve(process.cwd(), trimmed));
    }
    
    for (const absolutePath of searchPaths) {
        if (!existsSync(absolutePath)) continue;
        
        try {
            const content = readFileSync(absolutePath, "utf-8");
            const filename = path.basename(absolutePath);
            log("info", `📖 Goal loaded from file: ${filename}`);
            return content;
        } catch {
            continue;
        }
    }
    
    return null;
}

async function promptGoalChoice(): Promise<{ mode: "file" | "manual"; value: string }> {
    const choice = await select({
        message: "How would you like to input your goal?",
        options: [
            { label: "Type goal manually", value: "manual" },
            { label: "Load from file path", value: "file" },
        ],
    });

    if (isCancel(choice)) {
        cancel("Work session cancelled.");
        process.exit(0);
    }

    if (choice === "file") {
        const { text } = await import("@clack/prompts");
        const filePath = await text({
            message: "Enter file path:",
            placeholder: "goal.md, requirements.txt, etc.",
        });

        if (isCancel(filePath) || !String(filePath).trim()) {
            cancel("Work session cancelled: no file path provided.");
            process.exit(0);
        }

        return { mode: "file", value: String(filePath).trim() };
    }

    const goalInput = await text({
        message: "Enter your goal:",
        placeholder: "Build a landing page with authentication",
    });

    if (isCancel(goalInput) || !String(goalInput).trim()) {
        cancel("Work session cancelled: no goal provided.");
        process.exit(0);
    }

    return { mode: "manual", value: String(goalInput).trim() };
}

async function withConsoleRedirect<T>(fn: () => Promise<T> | T): Promise<T> {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    const write = (level: string, args: unknown[]): void => {
        const line = `[${new Date().toISOString()}] ${level}: ${args
            .map((a) => String(a))
            .join(" ")}`;
        // Print to terminal in real-time
        originalLog(line);
        // Also write to debug file
        if (DEBUG_LOG_PATH) {
            appendFile(DEBUG_LOG_PATH, line + "\n").catch(() => {});
        }
    };

    console.log = (...args: unknown[]) => write("INFO", args);
    console.warn = (...args: unknown[]) => write("WARN", args);
    console.error = (...args: unknown[]) => write("ERROR", args);

    try {
        return await fn();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }
}

function printRunBanner(
    runId: number,
    lessonsCount: number,
    totalRuns: number,
): void {
    logger.plain(
        [
            pc.cyan(`▶ START WORKING — RUN ${String(runId).padStart(2)}/${totalRuns}`),
            `• Prior run lessons: ${String(lessonsCount).padStart(2)}`,
        ].join("\n"),
    );
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

function formatFlatError(title: string, lines: string[]): string {
    return [
        pc.red(`❌ ${title}`),
        ...lines.map((line) => pc.dim(`• ${line}`)),
        "",
    ].join("\n");
}

async function waitForManagedGatewayReady(
    gatewayPort: number,
    token: string,
): Promise<boolean> {
    const apiPort = gatewayPort + 2;
    const modelsUrl = `http://127.0.0.1:${apiPort}/v1/models`;
    const headers: Record<string, string> = {};
    if (token.trim()) {
        headers.Authorization = `Bearer ${token.trim()}`;
    }

    let attempts = 0;
    while (attempts < 10) {
        attempts += 1;
        try {
            const res = await fetch(modelsUrl, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(1000),
            });
            if (res.status >= 100) {
                return true;
            }
        } catch {
            // continue polling until timeout
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return false;
}

async function waitForGatewayWithUi(
    canRenderSpinner: boolean,
    gatewayPort: number,
    token: string,
): Promise<void> {
    const readinessSpinner = canRenderSpinner ? spinner() : null;
    if (readinessSpinner) readinessSpinner.start("◌ Waiting for Gateway to initialize...");
    else log("info", "◌ Waiting for Gateway to initialize...");

    const gatewayReady = await waitForManagedGatewayReady(gatewayPort, token);
    if (!gatewayReady) {
        if (readinessSpinner) {
            readinessSpinner.stop("❌ Gateway did not become ready within 5 seconds.");
        }
        logger.plain(
            formatFlatError("GATEWAY STARTUP TIMEOUT", [
                `Gateway did not respond at http://127.0.0.1:${gatewayPort + 2}/v1/models within 5 seconds.`,
                `Suggestion: Verify OpenClaw startup logs and confirm WS/API ports (${gatewayPort} / ${gatewayPort + 2}).`,
                "Suggestion: Run `teamclaw run openclaw` to verify the gateway starts cleanly.",
            ]),
        );
        process.exit(1);
    }

    if (readinessSpinner) readinessSpinner.stop("✅ Gateway initialization complete.");
    else log("info", "Gateway initialization complete.");
}

function printSingleRunSummary(
    _goal: string,
    finalState: Record<string, unknown>,
    warnings: string[],
    team: BotDefinition[],
    workspacePath: string,
    startTime: number,
): void {
    const taskQueue = (finalState.task_queue ?? []) as Record<
        string,
        unknown
    >[];
    const cycleCount = (finalState.cycle_count as number) ?? 0;
    const botStats = (finalState.bot_stats as Record<string, Record<string, unknown>>) ?? {};

    const endTime = Date.now();
    const duration = endTime - startTime;

    const totalTasks = taskQueue.length;
    const completedTasks = taskQueue.filter((t) => t.status === "completed").length;
    const failedTasks = taskQueue.filter((t) => t.status === "failed").length;
    let totalReworks = 0;
    const contributions: string[] = [""];
    contributions.push(`  Total Tasks: ${totalTasks}`);

    for (const bot of team) {
        const stats = botStats[bot.id] ?? {};
        const completed = ((stats.tasks_completed as number) ?? 0);
        const failed = ((stats.tasks_failed as number) ?? 0);
        const reworks = ((stats.reworks_triggered as number) ?? 0);
        totalReworks += reworks;

        if (bot.role_id === "qa_reviewer") {
            contributions.push(`  ${bot.name}: ${reworks} reworks triggered`);
        } else if (completed > 0 || failed > 0) {
            contributions.push(`  ${bot.name}: ${completed} tasks completed, ${failed} failed`);
        }
    }

    const approvalRate = totalReworks + completedTasks > 0
        ? Math.round((completedTasks / (totalReworks + completedTasks)) * 100)
        : 100;

    let performanceVerdict = "";
    if (approvalRate >= 90) {
        performanceVerdict = "Team efficiency was excellent with minimal rework needed.";
    } else if (approvalRate >= 70) {
        performanceVerdict = "Team performed well with moderate rework.";
    } else if (approvalRate >= 50) {
        performanceVerdict = "Team had significant quality friction - consider clarifying requirements.";
    } else {
        performanceVerdict = "High rework rate detected - task definitions may need improvement.";
    }

    const lines: string[] = [
        "",
        pc.cyan("RUN SUMMARY"),
        `• Workspace: ${workspacePath}`,
        `• Duration: ${formatDuration(duration)}`,
        `• Cycles: ${cycleCount}`,
        "• Review Statistics:",
        `  - Tasks Completed: ${completedTasks}`,
        `  - Tasks Failed: ${failedTasks}`,
        `  - Total Reworks: ${totalReworks}`,
        `  - Approval Rate: ${approvalRate}%`,
        "• Individual Contributions:",
        ...contributions
            .filter((c) => c.trim().length > 0)
            .map((c) => `  - ${c.trim()}`),
        `• Performance Verdict: ${performanceVerdict}`,
    ];

    if (warnings.length > 0) {
        lines.push("");
        lines.push("Warnings:");
        warnings.forEach((w) => lines.push(`  ⚠ ${w}`));
    }

    logger.plain(lines.join("\n"));
}

function printWorkSummary(
    stats: {
        runs_completed: number;
        failures: number;
        longest_run_cycles: number;
        total_tasks_completed: number;
        total_lessons_learned: number;
    },
    lessons: string[],
): void {
    const trafficStats = getTrafficController().getStats();
    const oldest = lessons[0] ?? "(none)";
    const newest = lessons[lessons.length - 1] ?? "(none)";
    logger.plain(
        [
            pc.cyan("WORK SESSIONS COMPLETE"),
            `• Completed: ${stats.runs_completed}`,
            `• Failures: ${stats.failures}`,
            `• Successful: ${stats.runs_completed - stats.failures}`,
            `• Longest run: ${stats.longest_run_cycles} cycles`,
            `• Total tasks completed: ${stats.total_tasks_completed}`,
            `• API Requests Made: ${trafficStats.totalRequests}`,
            `• Lessons learned: ${stats.total_lessons_learned}`,
            `• Total lessons: ${lessons.length}`,
            "",
            pc.cyan("TRAFFIC CONTROL"),
            `• Max concurrent: ${trafficStats.maxRequests}`,
            `• Requests used: ${trafficStats.totalRequests}/${trafficStats.maxRequests}`,
            "",
            pc.cyan("LESSONS ACCUMULATED"),
            `• Oldest: "${oldest}"`,
            `• Newest: "${newest}"`,
        ].join("\n"),
    );
    lessons.forEach((l, i) => logger.plain(`  ${i + 1}. ${l}`));
    logger.plain([
        "",
        "History saved to:",
        "• work_history.log",
        "• data/vector_store/",
        "",
    ].join("\n"));
}

export async function runWork(
    input: string[] | { args?: string[]; goal?: string; openDashboard?: boolean; noWeb?: boolean } = [],
): Promise<void> {
    const args = Array.isArray(input) ? input : (input.args ?? []);
    const goalOverride = Array.isArray(input) ? undefined : input.goal?.trim();
    // Pillar 4: --no-web flag suppresses the TeamClaw Web Dashboard auto-start
    const noWebFromInput = !Array.isArray(input) && input.noWeb === true;
    let maxRuns = 1;
    let timeoutMinutes: number | undefined = undefined;
    let clearLegacy = false;
    let autoApprove = false;
    // Pillar 4: parsed from CLI flags
    let noWebFlag = noWebFromInput;
    let warnedInfraFlag = false;

    const shutdown = () => {
        log("warn", "Shutting down work session...");
        cleanupManagedGateway();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const trafficController = getTrafficController();
    trafficController.setPauseCallback(async () => {
        if (!canRenderSpinner) return false;
        const { select } = await import("@clack/prompts");
        const choice = await select({
            message: pc.yellow("⚠️ Safety limit reached! The team has made 50 requests. Continue?"),
            options: [
                { label: "Continue (resume work)", value: "continue" },
                { label: "Stop here", value: "stop" },
            ],
        });
        return choice === "continue";
    });

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--runs" && args[i + 1]) {
            maxRuns = Math.max(1, parseInt(args[i + 1], 10) || 1);
            i++;
        } else if (args[i] === "--generations" && args[i + 1]) {
            maxRuns = Math.max(1, parseInt(args[i + 1], 10) || 1);
            i++;
        } else if (args[i] === "--timeout" && args[i + 1]) {
            timeoutMinutes = Math.max(1, parseInt(args[i + 1], 10) || 30);
            i++;
        } else if (args[i]?.startsWith("--timeout=")) {
            const val = args[i]?.replace("--timeout=", "");
            timeoutMinutes = Math.max(1, parseInt(val, 10) || 30);
        } else if (args[i] === "--clear-legacy") {
            clearLegacy = true;
        } else if (args[i] === "--auto-approve") {
            autoApprove = true;
        } else if (args[i] === "--no-web") {
            // Pillar 4: opt-out of automatic web dashboard
            noWebFlag = true;
        } else if (
            args[i] === "--discover" ||
            args[i] === "--no-managed-gateway" ||
            args[i] === "--port" ||
            args[i] === "-p" ||
            args[i]?.startsWith("--port=")
        ) {
            if (!warnedInfraFlag) {
                logger.warn(
                    "Ignoring infrastructure override flags for `teamclaw work` (Pillar 2 zero-config). Run `teamclaw setup` or `teamclaw config` instead.",
                );
                warnedInfraFlag = true;
            }
            if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) i++;
        }
    }

    const canRenderSpinner = Boolean(
        process.stdout.isTTY && process.stderr.isTTY,
    );

    // Pillar 2: `teamclaw work` reads runtime infrastructure exclusively from setup config.
    const persistedGlobalConfig = readGlobalConfig();
    const setupConfig = persistedGlobalConfig ?? readGlobalConfigWithDefaults();
    if (!persistedGlobalConfig) {
        logger.warn(
            "No setup config found at ~/.teamclaw/config.json. Using strict defaults (ws://127.0.0.1:8001, http://127.0.0.1:8003). Run `teamclaw setup` to persist your environment.",
        );
    }

    const gatewayPort = setupConfig.gatewayPort;
    const gatewayPortStr = String(gatewayPort);
    const gatewayUrl = setupConfig.gatewayUrl;
    const apiUrl = setupConfig.apiUrl;

    setOpenClawWorkerUrl(gatewayUrl);
    setOpenClawHttpUrl(apiUrl);
    setOpenClawToken(setupConfig.token);
    setOpenClawChatEndpoint(setupConfig.chatEndpoint || "/v1/chat/completions");
    if (setupConfig.model) {
        setOpenClawModel(setupConfig.model);
    }

    setDebugMode(setupConfig.debugMode ?? CONFIG.debugMode ?? false);

    // Pillar 2: ONLY prompt allowed in `work` normal flow.
    let effectiveGoal = goalOverride;
    
    // Feature 2: Check if goalOverride is a file path
    if (effectiveGoal) {
        const fileContent = resolveGoalFromFile(effectiveGoal, CONFIG.workspaceDir);
        if (fileContent) {
            effectiveGoal = fileContent;
        }
    }
    
    if (!effectiveGoal && canRenderSpinner) {
        // Feature: Use explicit select prompt (file path vs manual)
        const goalChoice = await promptGoalChoice();
        
        if (goalChoice.mode === "file") {
            const fileContent = resolveGoalFromFile(goalChoice.value, CONFIG.workspaceDir);
            if (fileContent) {
                effectiveGoal = fileContent;
            } else {
                cancel(`Work session cancelled: file not found or unsupported format: ${goalChoice.value}`);
                process.exit(1);
            }
        } else {
            effectiveGoal = goalChoice.value;
        }
    }

    // ---------------------------------------------------------------------------
    // Session Configuration (Runs & Timeout) - Only prompt if not provided via flags
    // ---------------------------------------------------------------------------
    const DEFAULT_MAX_RUNS = 3;
    const DEFAULT_TIMEOUT_MINUTES = 30;

    if (canRenderSpinner) {
        if (!goalOverride && !effectiveGoal) {
            const runsInput = await select({
                message: "How many cycles should the team run?",
                options: [
                    { label: "1 cycle", value: 1 },
                    { label: "3 cycles (Recommended)", value: 3 },
                    { label: "5 cycles", value: 5 },
                    { label: "10 cycles", value: 10 },
                    { label: "Unlimited", value: 0 },
                ],
            });

            if (!isCancel(runsInput)) {
                maxRuns = runsInput as number;
            }
        }

        if (timeoutMinutes === undefined) {
            const timeoutInput = await select({
                message: "How many minutes should the session last?",
                options: [
                    { label: "15 minutes", value: 15 },
                    { label: "30 minutes (Recommended)", value: 30 },
                    { label: "60 minutes", value: 60 },
                    { label: "120 minutes", value: 120 },
                    { label: "No timeout", value: 0 },
                ],
            });

            if (!isCancel(timeoutInput)) {
                timeoutMinutes = timeoutInput as number;
            }
        }
    }

    // Apply defaults if still undefined (non-TTY or user skipped)
    if (maxRuns === undefined || maxRuns === 1) {
        maxRuns = DEFAULT_MAX_RUNS;
    }
    if (timeoutMinutes === undefined) {
        timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
    }

    logger.plain(pc.gray(`>>> Session: ${maxRuns} runs, ${timeoutMinutes}min timeout`));

    // ---------------------------------------------------------------------------
    // WORKSPACE SELECTION - Skip if goal provided via CLI (use cwd as default)
    // ---------------------------------------------------------------------------
    let workspacePath: string;
    const skipWorkspacePrompt = !!goalOverride;
    
    if (canRenderSpinner && !skipWorkspacePrompt) {
        const selectedPath = await promptPath({
            message: "Select workspace directory:",
            cwd: process.cwd(),
        });

        if (selectedPath === null) {
            cancel("Work session cancelled.");
            process.exit(0);
        }

        workspacePath = selectedPath;
    } else {
        workspacePath = path.resolve(process.cwd());
    }

    // TypeScript can't prove workspacePath is always assigned due to complex control flow
    // but all paths either assign or call process.exit(0)
    workspacePath ||= path.resolve(process.cwd());



    // ---------------------------------------------------------------------------
    // Pillar 4: Auto-start TeamClaw Web Dashboard in the background
    // ---------------------------------------------------------------------------
    let webPort = 9001;
    if (!noWebFlag) {
        const { start: startDaemon, status: daemonStatus } = await import("./daemon/manager.js");
        webPort = Number(process.env["WEB_PORT"]) || setupConfig.dashboardPort || 9001;
        const daemonResult = startDaemon({ web: true, gateway: false, webPort });
        const actualStatus = daemonStatus();
        const actualPort = actualStatus.webPort || webPort;
        if (!daemonResult.error || daemonResult.error.includes("already running")) {
            const dashboardUrl = `http://localhost:${actualPort}`;
            logger.plain("");
            logger.plain(pc.bold(pc.green(`>>> TeamClaw Dashboard: ${dashboardUrl}`)));
            logger.plain("");
            
            // Auto-open dashboard in browser
            try {
                const { default: open } = await import("open");
                await open(dashboardUrl);
            } catch {
                // Ignore - non-critical
            }
        } else {
            logger.warn(`Dashboard auto-start skipped: ${daemonResult.error}`);
        }
    }

    const gatewayAlreadyRunning = await isPortInUse(gatewayPort);

    if (setupConfig.managedGateway && gatewayAlreadyRunning) {
        log("info", `Gateway already running on port ${gatewayPort}. Attaching...`);
        setupGatewayCleanupHandlers();
        await waitForGatewayWithUi(canRenderSpinner, gatewayPort, setupConfig.token);
    }

    if (!gatewayAlreadyRunning) {
        if (setupConfig.managedGateway) {
            setupGatewayCleanupHandlers();
            const { startManagedGateway } = await import("./commands/run-openclaw.js");

            const gatewayState = await startManagedGateway(gatewayPortStr, { useSpinner: canRenderSpinner });

            if (!gatewayState.wasAlreadyRunning) {
                log("info", `Managed gateway started (PID: ${gatewayState.pid})`);
            }
            await waitForGatewayWithUi(canRenderSpinner, gatewayPort, setupConfig.token);
        } else {
            logger.plain(
                formatFlatError("EXTERNAL GATEWAY UNREACHABLE", [
                    `Cause: Connection refused at ${gatewayUrl}`,
                    "Suggestion: Run `teamclaw setup` to reconfigure your environment.",
                    "Suggestion: Run `teamclaw config` to edit gateway settings.",
                    "Suggestion: Run `teamclaw run openclaw` to start the gateway manually.",
                ]),
            );

            if (canRenderSpinner) {
                const recovery = await select({
                    message: "How would you like to recover?",
                    options: [
                        {
                            label: "🔄 Auto-Fix: Start OpenClaw gateway on configured port",
                            value: "start_gateway",
                        },
                        {
                            label: "⚙️  Reconfigure: Run `teamclaw setup` wizard",
                            value: "setup",
                        },
                        {
                            label: "🚪 Exit",
                            value: "exit",
                        },
                    ],
                });

                if (!isCancel(recovery)) {
                    if (recovery === "start_gateway") {
                        const { startOpenclawGateway } = await import("./commands/run-openclaw.js");
                        await startOpenclawGateway({ port: gatewayPortStr, skipPrompt: true });
                        log("warn", "Gateway started. Please retry `teamclaw work`.");
                    } else if (recovery === "setup") {
                        const { runSetup } = await import("./commands/setup.js");
                        await runSetup();
                        return;
                    }
                }
            }
            process.exit(1);
        }
    }

    const health = await runGatewayHealthCheck();
    const pingCheck = health.checks.find((c) => c.name === "ping");
    const authCheck = health.checks.find((c) => c.name === "auth");
    const pingPass = pingCheck?.level === "pass";
    const authPass = authCheck?.level === "pass";
    const fatalConnectivityIssue =
        !pingPass || (!authPass && health.authStatus === "invalid");

    if (fatalConnectivityIssue) {
        // -----------------------------------------------------------------------
        // Pillar 3: Smart Error Recovery — structured diagnostic output
        // -----------------------------------------------------------------------
        const authFailed = health.authStatus === "invalid";
        const pingFailure = health.checks.find(
            (c) => c.name === "ping" && c.level === "fail",
        );
        const modelFailed = health.checks.find(
            (c) => c.name === "model" && c.level === "fail",
        );

        const diagLines: string[] = [];
        if (authFailed) {
            diagLines.push(
                "Cause: Gateway returned HTTP 401 or 403.",
                "Suggestion: Verify OPENCLAW_TOKEN or run `teamclaw setup`.",
            );
        } else if (pingFailure) {
            diagLines.push(
                `Cause: Connection refused at ${health.gatewayUrl}.`,
                `Detail: ${pingFailure.message}`,
                "Suggestion: Ensure the gateway process is running and reachable.",
            );
        }

        if (modelFailed && !authFailed && !pingFailure) {
            diagLines.push(
                `Detail: ${modelFailed.message}`,
                "Suggestion: Verify OPENCLAW_MODEL against the gateway model list.",
            );
        }

        diagLines.push(
            "Suggestion: Run `teamclaw setup` to reconfigure your environment.",
            "Suggestion: Run `teamclaw config` to edit individual settings.",
            "Suggestion: Run `teamclaw run openclaw` to start/restart the gateway.",
        );

        logger.plain(formatFlatError("GATEWAY CONNECTION FAILED", diagLines));

        if (health.tip) {
            log("warn", health.tip);
        }

        if (canRenderSpinner) {
            const recoveryOptions = gatewayAlreadyRunning
                ? [
                      {
                          label: "🔍 Re-detect Gateway (run setup)",
                          value: "redetect",
                      },
                      {
                          label: "⚙️  Check Config",
                          value: "check_config",
                      },
                      {
                          label: "🚪 Exit",
                          value: "exit",
                      },
                  ]
                : [
                      {
                          label: "🔄 Auto-Fix: Start the OpenClaw gateway now",
                          value: "start_gateway",
                      },
                      {
                          label: "⚙️  Reconfigure: Run `teamclaw setup` wizard",
                          value: "setup",
                      },
                      {
                          label: "🚪 Exit",
                          value: "exit",
                      },
                  ];

            const recovery = await select({
                message: "How would you like to recover?",
                options: recoveryOptions,
            });

            if (!isCancel(recovery)) {
                if (recovery === "start_gateway") {
                    const portInUse = await isPortInUse(gatewayPort);
                    if (portInUse) {
                        log("info", `Gateway already running on port ${gatewayPort}. Attaching...`);
                        await waitForGatewayWithUi(
                            canRenderSpinner,
                            gatewayPort,
                            setupConfig.token,
                        );
                    } else {
                        const { startOpenclawGateway } = await import("./commands/run-openclaw.js");
                        await startOpenclawGateway({ port: gatewayPortStr, skipPrompt: false });
                        log("warn", "Gateway started. Please retry `teamclaw work`.");
                    }
                } else if (recovery === "redetect") {
                    const { runSetup } = await import("./commands/setup.js");
                    await runSetup();
                    return;
                } else if (recovery === "check_config") {
                    logger.plain(
                        formatFlatError("CURRENT GATEWAY CONFIG", [
                            `Gateway URL: ${gatewayUrl}`,
                            `API URL: ${apiUrl}`,
                            `Gateway Port: ${gatewayPort}`,
                            `Expected API Port: ${gatewayPort + 2}`,
                            `Managed Gateway: ${setupConfig.managedGateway ? "yes" : "no"}`,
                        ]),
                    );
                } else if (recovery === "setup") {
                    const { runSetup } = await import("./commands/setup.js");
                    await runSetup();
                    return;
                }
            }
        }
        process.exit(1);
    }

    if (maxRuns > CONFIG.maxRuns) {
        maxRuns = CONFIG.maxRuns;
    }

    if (!canRenderSpinner) {
        log("info", "Start working!");
        log("info", `   Runs: ${maxRuns}`);
        log("info", "");
    }

    await ensureWorkspaceDir(CONFIG.workspaceDir);
    try {
        DEBUG_LOG_PATH = await rotateAndCreateSessionLog({
            logDir: path.join(os.homedir(), ".teamclaw", "logs"),
            prefix: "work-session",
            maxFiles: 10,
        });
    } catch {
        DEBUG_LOG_PATH = path.join(CONFIG.workspaceDir, "teamclaw-debug.log");
    }

    const memoryConfig = await loadTeamConfig();
    const selectedMemoryBackend: MemoryBackend =
        memoryConfig?.memory_backend ?? CONFIG.memoryBackend;
    if (selectedMemoryBackend === "local_json") {
        log(
            "info",
            "   Using local JSON memory backend (fast startup, no Docker).",
        );
    } else {
        log(
            "info",
            "   Using embedded LanceDB memory backend (fast startup, no Docker).",
        );
    }

    const vectorMemory = new VectorMemory(
        CONFIG.vectorStorePath,
        selectedMemoryBackend,
    );
    await vectorMemory.init();

    if (clearLegacy) {
        log(
            "warn",
            "Clearing lesson data is not implemented (delete data/vector_store manually)",
        );
    }

    const analyst = new PostMortemAnalyst(vectorMemory);
    let lastTotalReworks = 0;
    let lastFinalState: Record<string, unknown> | null = null;
    const workStats = {
        runs_completed: 0,
        total_lessons_learned: 0,
        longest_run_cycles: 0,
        total_tasks_completed: 0,
        failures: 0,
    };

    const defaultGoal = getDefaultGoal();

    const teamConfigForValidation = memoryConfig ?? (await loadTeamConfig());
    const result = await validateStartup({
        templateId: teamConfigForValidation?.template,
        maxCycles: CONFIG.maxCycles,
        maxRuns,
    });
    if (!result.ok) {
        log("error", result.message);
        process.exit(1);
    }

    log("info", pc.dim("💡 Tip: Press Ctrl+C to stop the work session. The managed gateway will be stopped automatically."));

    for (let runId = 1; runId <= maxRuns; runId++) {
        try {
            const teamConfig = await loadTeamConfig();
            const goal =
                effectiveGoal || teamConfig?.goal?.trim() || defaultGoal;
            const priorLessons = await vectorMemory.getCumulativeLessons();

            if (canRenderSpinner && runId === 1) {
                logger.info("🧠 Searching long-term memory for past project context...");
            }
            const projectContext = await vectorMemory.retrieveRelevantMemories(goal, 2);
            let projectContextStr = "";
            if (projectContext.length > 0) {
                if (canRenderSpinner) {
                    logger.success("📚 Found past context. Injecting into team instructions.");
                }
                projectContextStr = `\n\nContext from past projects: ${projectContext.join("; ")}. Please align your architectural decisions and coding style with these established preferences unless the current goal explicitly states otherwise.`;
            } else {
                if (canRenderSpinner && runId === 1) {
                    logger.info("🧠 No past project context found.");
                }
            }

            const runWarnings: string[] = [];
            clearSessionWarnings();
            if (!vectorMemory.enabled) {
                runWarnings.push(
                    "Vector DB unavailable or disabled. Using JSON fallback for lessons.",
                );
            }

            if (!canRenderSpinner) {
                if (maxRuns > 1) {
                    printRunBanner(runId, priorLessons.length, maxRuns);
                } else {
                    log("info", "Initializing work session...");
                }
                log("info", `   Goal: ${goal}`);
            }

            const template = teamConfig?.template ?? "maker_reviewer";
            const creativity =
                typeof teamConfig?.creativity === "number"
                    ? teamConfig.creativity
                    : CONFIG.creativity;
            setSessionConfig({
                creativity,
                gateway_url: teamConfig?.gateway_url,
                team_model: teamConfig?.team_model,
            });
            const team =
                teamConfig?.roster && teamConfig.roster.length > 0
                    ? buildTeamFromRoster(teamConfig.roster)
                    : buildTeamFromTemplate(template);

            const workerUrls = getWorkerUrlsForTeam(
                team.map((b) => b.id),
                {
                    workers: teamConfig?.workers,
                },
            );
            const openclawUrl =
                CONFIG.openclawWorkerUrl?.trim() ||
                (Object.values(workerUrls)[0] as string | undefined);
            if (!openclawUrl) {
                throw new Error(
                    "❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.",
                );
            }
            if (runId === 1) {
                let provisioned = false;
                let lastError: string | undefined;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    const r = await provisionOpenClaw({
                        workerUrl: openclawUrl,
                    });
                    if (r.ok) {
                        provisioned = true;
                        log("info", "OpenClaw provisioned");
                        break;
                    }
                    lastError = r.error;
                    log(
                        "warn",
                        `OpenClaw provisioning attempt ${attempt} failed: ${r.error ?? "unknown error"}`,
                    );
                    if (attempt < 2)
                        await new Promise((res) => setTimeout(res, 2000));
                }
                if (!provisioned) {
                    throw new Error(
                        `❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.${
                            lastError ? ` Details: ${lastError}` : ""
                        }`,
                    );
                }
            }
            const orchestration = createTeamOrchestration({ team, workerUrls, workspacePath, autoApprove });
            const runStartTime = Date.now();

            // Telemetry init - connection status logged prominently
            if (runId === 1) {
                try {
                    const { initCanvasTelemetry, getCanvasTelemetry } = await import("./core/canvas-telemetry.js");
                    const telemetryConnected = await initCanvasTelemetry();
                    if (telemetryConnected) {
                        getCanvasTelemetry().sendSessionStart(goal);
                        logger.success(">>> WebSocket Telemetry: CONNECTED");
                    } else {
                        logger.warn(">>> Telemetry Bridge failed. Dashboard will not update in real-time.");
                    }
                } catch {
                    logger.warn(">>> Telemetry Bridge failed. Dashboard will not update in real-time.");
                }
            }

            let finalState: Record<string, unknown>;
            if (canRenderSpinner) {
                const sPlan = spinner();
                const startTime = Date.now();
                let elapsedSeconds = 0;
                sPlan.start("🧠 Coordinator is decomposing the goal...");
                
                // Heartbeat spinner - update every 5 seconds to show we're waiting
                const heartbeatInterval = setInterval(() => {
                    elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                    sPlan.start(`🧠 Coordinator is decomposing the goal... (${elapsedSeconds}s)`);
                }, 5000);
                
                try {
                    finalState = (await (isDebugMode()
                        ? orchestration.run({
                              userGoal: goal,
                              ancestralLessons: priorLessons,
                              projectContext: projectContextStr,
                              maxRuns,
                              timeoutMinutes,
                          })
                        : withConsoleRedirect(() =>
                              orchestration.run({
                                  userGoal: goal,
                                  ancestralLessons: priorLessons,
                                  projectContext: projectContextStr,
                                  maxRuns,
                                  timeoutMinutes,
                              }),
                          ))) as Record<string, unknown>;
                } catch (error) {
                    clearInterval(heartbeatInterval);
                    const message =
                        error instanceof Error ? error.message : String(error);
                    sPlan.stop(
                        `❌ Coordinator failed to decompose goal: ${message}`,
                    );
                    // Fast-fail on HTTP/network errors — skip summary UI and exit immediately.
                    const isFatal =
                        /HTTP [45]\d\d|ECONNREFUSED|ENOTFOUND|404|Not Found|fetch failed/i.test(message);
                    if (isFatal) {
                        // Pillar 3: structured diagnostic on coordinator failure
                        cancel(
                            `Fatal Error: Coordinator failed — ${message.split("\n")[0]}.\n` +
                            `  • Gateway: ${gatewayUrl}\n` +
                            `  • Run \`teamclaw setup\` to reconfigure, or \`teamclaw run openclaw\` to restart.`,
                        );
                        clearSessionConfig();
                        process.exit(1);
                    }
                    throw error;
                }
                
                clearInterval(heartbeatInterval);

                const taskQueue = (finalState.task_queue ?? []) as Record<
                    string,
                    unknown
                >[];
                sPlan.stop(
                    `✅ Goal decomposed into ${taskQueue.length} tasks.`,
                );

                const executionMessages = (finalState.messages ?? []) as string[];
                for (const msg of executionMessages) {
                    if (msg.startsWith("▶")) {
                        clackLog.step(msg);
                    } else if (msg.startsWith("✅")) {
                        clackLog.success(msg);
                    } else if (msg.startsWith("❌")) {
                        clackLog.error(msg);
                    } else if (msg.startsWith("👀")) {
                        clackLog.info(msg);
                    } else if (msg.startsWith("🔧")) {
                        clackLog.warn(msg);
                    } else if (msg.startsWith("📝")) {
                        clackLog.info(msg);
                    } else {
                        clackLog.info(msg);
                    }
                }

                for (const t of taskQueue) {
                    const id = (t.task_id as string) ?? "?";
                    const botId = (t.assigned_to as string) ?? "?";
                    const botName = getBotName(botId, team);
                    const taskStatus = (t.status as string) ?? "pending";

                    if (taskStatus === "completed" || taskStatus === "failed") {
                        const sTask = spinner();
                        sTask.start(`Finalizing: ${id}...`);
                        if (taskStatus === "completed") {
                            sTask.stop(`✅ [${botName}] Completed: ${id}`);
                        } else {
                            const result = (t.result ?? null) as Record<
                                string,
                                unknown
                            > | null;
                            const rawReason =
                                result?.output != null
                                    ? String(result.output).trim()
                                    : "Unknown failure";
                            const oneLineReason = rawReason.replace(/\s+/g, " ");
                            const shortReason = oneLineReason.slice(0, 120);
                            sTask.stop(
                                `❌ [${botName}] Failed: ${id} | Reason: ${shortReason}${oneLineReason.length > 120 ? "…" : ""}`,
                            );
                            if (oneLineReason.length > 120) {
                                clackLog.error(oneLineReason);
                            }
                        }
                    }
                }
            } else {
                finalState = (await orchestration.run({
                    userGoal: goal,
                    ancestralLessons: priorLessons,
                    maxRuns,
                    timeoutMinutes,
                })) as Record<string, unknown>;
            }

            const botStats = (finalState as Record<string, unknown>)
                .bot_stats as Record<string, Record<string, unknown>> | null;
            const totalDone = botStats
                ? Object.values(botStats).reduce(
                      (s, x) => s + ((x?.tasks_completed as number) ?? 0),
                      0,
                  )
                : 0;
            const totalFailed = botStats
                ? Object.values(botStats).reduce(
                      (s, x) => s + ((x?.tasks_failed as number) ?? 0),
                      0,
                  )
                : 0;
            lastTotalReworks = botStats
                ? Object.values(botStats).reduce(
                      (s, x) => s + ((x?.reworks_triggered as number) ?? 0),
                      0,
                  )
                : 0;
            lastFinalState = finalState;

            workStats.runs_completed = runId;
            workStats.longest_run_cycles = Math.max(
                workStats.longest_run_cycles,
                (finalState as Record<string, unknown>).cycle_count as number,
            );
            workStats.total_tasks_completed += totalDone;

            const totalTasks = totalDone + totalFailed;
            const failed =
                totalTasks > 0 && (totalFailed >= totalDone || totalDone === 0);

            if (failed && maxRuns > 1) {
                workStats.failures += 1;
                log("error", `Run ${runId} failed`);
                log("info", "Running post-mortem analysis...");
                const cause = `Tasks: ${totalFailed} failed, ${totalDone} completed`;
                const stateWithCause = {
                    ...finalState,
                    death_reason: cause,
                    generation_id: runId,
                } as GraphState;
                const lesson = await analyst.analyzeFailure(stateWithCause);
                workStats.total_lessons_learned += 1;
                const report = analyst.generatePostMortemReport(
                    stateWithCause,
                    lesson,
                );
                logger.plain(report);
                log("info", `Lesson learned. Proceeding to run ${runId + 1}`);
                log("info", "");
            } else if (failed && maxRuns === 1) {
                log(
                    "warn",
                    `Work session completed with failures: ${totalDone} done, ${totalFailed} failed`,
                );
                break;
            } else {
                log("info", `Run ${runId} completed`);
                log(
                    "info",
                    `   Cycles: ${(finalState as Record<string, unknown>).cycle_count}`,
                );
                log(
                    "info",
                    `   Tasks: ${totalDone} completed, ${totalFailed} failed`,
                );
                if (maxRuns === 1) {
                    const allWarnings = [
                        ...runWarnings,
                        ...getSessionWarnings(),
                    ];
                    printSingleRunSummary(
                        goal,
                        finalState as Record<string, unknown>,
                        allWarnings,
                        team,
                        workspacePath,
                        runStartTime,
                    );
                }

                if (canRenderSpinner) {
                    logger.info("💾 Post-Mortem Analyst is saving session experience to LanceDB...");
                }
                const projectMemory = await analyst.extractProjectMemory(
                    finalState as GraphState,
                    workspacePath,
                );
                if (projectMemory) {
                    if (canRenderSpinner) {
                        logger.success(`📚 Saved project memory: "${projectMemory.slice(0, 50)}..."`);
                    }
                }

                log("info", "");
                if (maxRuns === 1) break;
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "SIGINT") {
                log("warn", "\nWork session interrupted by user");
                break;
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            const isFatal =
                /HTTP [45]\d\d|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|WebSocket closed|timeout/i.test(errMsg);

            if (isFatal) {
                // -----------------------------------------------------------------
                // Pillar 3: Smart Error Recovery during an active run
                // -----------------------------------------------------------------
                const isAuthError = /HTTP 401|HTTP 403|Unauthorized/i.test(errMsg);
                const isGatewayDown =
                    !isAuthError && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|WebSocket closed|fetch failed|timeout/i.test(errMsg);
                const isModelError =
                    !isGatewayDown && !isAuthError && /HTTP 404|Not Found|model/i.test(errMsg);

                const diagLines: string[] = [];
                if (isGatewayDown) {
                    diagLines.push(
                        `Cause: Connection refused at ${gatewayUrl}.`,
                        `Detail: ${errMsg.split("\n")[0] ?? errMsg}`,
                        "Suggestion: Check gateway process health and port availability.",
                    );
                } else if (isAuthError) {
                    diagLines.push(
                        "Cause: Gateway returned HTTP 401 or 403 mid-session.",
                        "Suggestion: Verify OPENCLAW_TOKEN in your environment.",
                    );
                } else if (isModelError) {
                    diagLines.push(
                        "Cause: Model not found (404) — possible model mismatch.",
                        "Suggestion: Verify OPENCLAW_MODEL in your environment.",
                    );
                } else {
                    diagLines.push(
                        `Cause: ${errMsg.split("\n")[0] ?? errMsg}`,
                    );
                }
                diagLines.push(
                    "Suggestion: Run `teamclaw setup` to reconfigure your environment.",
                    "Suggestion: Run `teamclaw config` to edit individual settings.",
                    "Suggestion: Run `teamclaw run openclaw` to restart the gateway.",
                );
                logger.plain(
                    formatFlatError(
                        "RUNTIME GATEWAY ERROR — WORK SESSION INTERRUPTED",
                        diagLines,
                    ),
                );

                if (canRenderSpinner) {
                    const recovery = await select({
                        message: "How would you like to recover?",
                        options: [
                            {
                                label: "🔄 Auto-Fix: Restart the OpenClaw gateway",
                                value: "restart_gateway",
                            },
                            {
                                label: "⚙️  Reconfigure: Run `teamclaw setup` wizard",
                                value: "setup",
                            },
                            {
                                label: "🚪 Exit",
                                value: "exit",
                            },
                        ],
                    });

                    if (!isCancel(recovery)) {
                        if (recovery === "restart_gateway") {
                            const { startOpenclawGateway } = await import("./commands/run-openclaw.js");
                            await startOpenclawGateway({ skipPrompt: false });
                            log("warn", "Gateway restarted. Please retry `teamclaw work`.");
                        } else if (recovery === "setup") {
                            clearSessionConfig();
                            const { runSetup } = await import("./commands/setup.js");
                            await runSetup();
                            return;
                        }
                    }
                }

                clearSessionConfig();
                process.exit(1);
            }
            log("error", `Fatal error in run ${runId}: ${err}`);
            logger.error(String(err));
            break;
        }
    }

    clearSessionConfig();
    if (maxRuns > 1) {
        const lessons = await vectorMemory.getCumulativeLessons();
        if (canRenderSpinner) {
            const oldest = lessons[0] ?? "(none)";
            const newest = lessons[lessons.length - 1] ?? "(none)";
            const body = [
                `Runs: ${workStats.runs_completed} (failures: ${workStats.failures})`,
                `Longest run: ${workStats.longest_run_cycles} cycles`,
                `Tasks completed: ${workStats.total_tasks_completed}`,
                `Lessons learned: ${workStats.total_lessons_learned}`,
                "",
                `Total lessons: ${lessons.length}`,
                `Oldest: "${oldest}"`,
                `Newest: "${newest}"`,
            ].join("\n");
            note(body, "Work sessions complete");
        } else {
            printWorkSummary(workStats, lessons);
        }
    } else {
        if (canRenderSpinner) {
            note("Single work session finished.", "Work session complete");
        } else {
            log("info", "Work session finished.");
        }
    }

    if (lastTotalReworks > 0 && lastFinalState) {
        if (canRenderSpinner) {
            logger.info("🔄 Running Sprint Retrospective (rework detected)...");
        }
        
        const retroAgent = new RetrospectiveAgent(vectorMemory);
        
        const retroResult = await retroAgent.analyze(
            lastFinalState as GraphState,
            workspacePath,
        );
        
        if (retroResult) {
            if (canRenderSpinner) {
                logger.success("📝 Sprint Retrospective complete! Check docs/RETROSPECTIVE.md");
            } else {
                log("info", "📝 Sprint Retrospective saved to docs/RETROSPECTIVE.md");
            }
        }
    }

    cleanupManagedGateway();
}
