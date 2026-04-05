/**
 * Work Runner - Team orchestration sessions with lesson learning.
 *
 * @deprecated Sprint-based execution is superseded by Session-based
 * interactive mode. See src/session/ for the new runtime.
 * This module will be removed in v2.0.0.
 */

import { createTeamOrchestration } from "./core/simulation.js";
import { analyzeGoal } from "./agents/composition/analyzer.js";
import type { TeamComposition } from "./agents/composition/types.js";
import { renderCompositionTable, promptCompositionAction, applyOverrides } from "./cli/composition-preview.js";
import { SessionRecorder, setActiveRecorder, createSession, finalizeSession } from "./replay/index.js";
// buildAuditTrail, renderAuditMarkdown moved to session-finalize.ts
import {
    buildTeamFromRoster,
    buildTeamFromTemplate,
} from "./core/team-templates.js";
import {
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
} from "./core/config.js";
import { validateStartup } from "./core/startup-validation.js";
import { existsSync } from "node:fs";
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
import { log as clackLog, note, spinner, cancel } from "@clack/prompts";
import pc from "picocolors";
import { readGlobalConfig, readGlobalConfigWithDefaults } from "./core/global-config.js";
import { rotateAndCreateSessionLog } from "./utils/log-rotation.js";
import { getTrafficController } from "./core/traffic-control.js";
import { promptPath } from "./utils/path-autocomplete.js";
import { randomPhrase } from "./utils/spinner-phrases.js";

import { collectBriefingData, renderBriefing, renderInterRunSummary } from "./briefing/index.js";
import { resolveGoalFromFile, checkWorkspaceContent, promptGoalChoice, runPreFlightChecks } from "./work-runner/goal-resolver.js";
import {
    getBotName,
    printRunBanner,
    printSingleRunSummary,
    printWorkSummary,
} from "./work-runner/outcome-reporter.js";
import { getGlobalProviderManager } from "./providers/provider-factory.js";
import { startDashboard } from "./work-runner/dashboard-setup.js";
import { parseWorkArgs, promptSessionConfig, promptPreLaunchConfirmation } from "./work-runner/session-config.js";
import { workerEvents } from "./core/worker-events.js";
import { startGatewayLogTailer } from "./core/gateway-log-tailer.js";
import { ProfileBuilder, checkDegradation } from "./agents/profiles/index.js";
import type { CompletedTaskResult } from "./agents/profiles/types.js";
import { createWebhookApprovalProvider } from "./webhook/provider.js";
import type { WebhookApprovalConfig } from "./webhook/types.js";
import { SuccessPatternStore } from "./memory/success/store.js";
import { LearningCurveStore } from "./memory/success/learning-curve.js";
import { PatternQualityStore, pruneStalePatterns } from "./memory/success/quality.js";
import { ResponseCacheStore } from "./cache/cache-store.js";
import { resetSessionCacheStats } from "./cache/cache-interceptor.js";
import { resetTokenOptStats } from "./token-opt/stats.js";
import { getHealthMonitor, getProviderManager } from "./proxy/ProxyService.js";
import type { SuccessPattern } from "./memory/success/types.js";
import { GlobalMemoryManager } from "./memory/global/store.js";
import { PromotionEngine } from "./memory/global/promoter.js";
import { GlobalPruner } from "./memory/global/pruner.js";
import { finalizeSprintMemories } from "./memory/realtime-promoter.js";
import { getSprintScratchpad } from "./memory/sprint-scratchpad.js";
import { log, withConsoleRedirect, initLogPaths } from "./work-runner/log.js";
import { UserCancelError, FatalSessionError } from "./work-runner/types.js";
import { autoExportAudit, autoGenerateContext, buildCustomCompositionRules } from "./work-runner/session-finalize.js";

// autoExportAudit, autoGenerateContext, buildCustomCompositionRules extracted to ./work-runner/session-finalize.ts

export async function runWork(
    input: string[] | { args?: string[]; goal?: string; openDashboard?: boolean; noWeb?: boolean } = [],
): Promise<void> {
  try {
    const args = Array.isArray(input) ? input : (input.args ?? []);
    const goalOverride = Array.isArray(input) ? undefined : input.goal?.trim();
    const noWebFromInput = !Array.isArray(input) && input.noWeb === true;
    const parsed = parseWorkArgs(args);
    let { maxRuns } = parsed;
    let timeoutMinutes = parsed.timeoutMinutes ?? 0;
    let sessionMode = parsed.sessionMode;
    const { clearLegacy, autoApprove, noPreview, asyncMode, asyncTimeout, noBriefing, noInteractive } = parsed;
    let noWebFlag = parsed.noWebFlag || noWebFromInput;

    // Raise listener limit — @clack/prompts adds keypress/readline listeners
    process.setMaxListeners(30);
    if (process.stdin.setMaxListeners) process.stdin.setMaxListeners(30);
    if (process.stdout.setMaxListeners) process.stdout.setMaxListeners(30);

    const sessionAbort = new AbortController();
    const shutdown = () => {
        log("warn", "Shutting down work session...");
        sessionAbort.abort();
        setTimeout(() => process.exit(0), 500);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    const canRenderSpinner = Boolean(
        process.stdout.isTTY && process.stderr.isTTY,
    );

    const trafficController = getTrafficController();
    trafficController.setPauseCallback(async () => {
        if (!canRenderSpinner || noInteractive) return false;
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

    // ---------------------------------------------------------------------------
    // Infrastructure config — verify providers are available
    // ---------------------------------------------------------------------------
    const persistedGlobalConfig = readGlobalConfig();
    const setupConfig = persistedGlobalConfig ?? readGlobalConfigWithDefaults();
    if (!persistedGlobalConfig) {
        const { formatFirstRunMessage } = await import("./core/errors.js");
        logger.plain(formatFirstRunMessage());
    }

    const pm = getGlobalProviderManager();
    if (pm.getProviders().length === 0) {
        throw new Error("No LLM providers configured. Run `openpawl setup` or set an API key env var.");
    }

    setDebugMode(setupConfig.debugMode ?? CONFIG.debugMode ?? false);

    // ---------------------------------------------------------------------------
    // Session briefing — show "previously on OpenPawl" before goal prompt
    // ---------------------------------------------------------------------------
    const briefingDisabledInConfig = (() => {
        try {
            const rawCfg = persistedGlobalConfig as unknown as Record<string, unknown>;
            const briefingCfg = rawCfg?.briefing as Record<string, unknown> | undefined;
            return briefingCfg?.enabled === false;
        } catch { return false; }
    })();
    if (!noBriefing && !briefingDisabledInConfig && canRenderSpinner) {
        try {
            const briefingData = await collectBriefingData();
            const briefingOutput = renderBriefing(briefingData);
            logger.plain(briefingOutput);
            await new Promise((r) => setTimeout(r, 300));
        } catch {
            // Briefing must never crash work session — skip silently
        }
    }

    // ---------------------------------------------------------------------------
    // Goal resolution
    // ---------------------------------------------------------------------------
    let effectiveGoal = goalOverride;

    if (effectiveGoal) {
        const fileContent = resolveGoalFromFile(effectiveGoal, CONFIG.workspaceDir, log);
        if (fileContent) {
            effectiveGoal = fileContent;
        }
    }

    if (!effectiveGoal) {
        const savedTeamCfg = await loadTeamConfig();
        const savedGoal = savedTeamCfg?.goal?.trim();
        if (savedGoal) {
            effectiveGoal = savedGoal;
        }
    }

    if (!effectiveGoal && canRenderSpinner) {
        const goalChoice = await promptGoalChoice();

        if (goalChoice.mode === "file") {
            const fileContent = resolveGoalFromFile(goalChoice.value, CONFIG.workspaceDir, log);
            if (fileContent) {
                effectiveGoal = fileContent;
            } else {
                throw new FatalSessionError(`File not found or unsupported format: ${goalChoice.value}`);
            }
        } else {
            effectiveGoal = goalChoice.value;
        }
    }

    // ---------------------------------------------------------------------------
    // Session configuration
    // ---------------------------------------------------------------------------
    const hasConfiguredSession = !!effectiveGoal;

    if (!hasConfiguredSession && !goalOverride) {
        const sessionCfg = await promptSessionConfig(canRenderSpinner, { ...parsed, maxRuns, timeoutMinutes, sessionMode });
        maxRuns = sessionCfg.maxRuns;
        timeoutMinutes = sessionCfg.timeoutMinutes;
        sessionMode = sessionCfg.sessionMode;
    } else {
        // Apply defaults
        if (sessionMode === undefined) sessionMode = "runs";
        if (sessionMode === "runs") {
            if (maxRuns === 1) maxRuns = 3;
            timeoutMinutes = 0;
        } else {
            if (!timeoutMinutes) timeoutMinutes = 30;
            maxRuns = 999;
        }
    }

    // ---------------------------------------------------------------------------
    // Workspace selection
    // ---------------------------------------------------------------------------
    let workspacePath: string;
    const savedWorkspace = setupConfig.workspaceDir?.trim() || CONFIG.workspaceDir?.trim();

    if (savedWorkspace && existsSync(savedWorkspace)) {
        workspacePath = path.resolve(savedWorkspace);
    } else if (canRenderSpinner && !noInteractive) {
        const selectedPath = await promptPath({
            message: "Select workspace directory:",
            cwd: process.cwd(),
        });

        if (selectedPath === null) {
            throw new UserCancelError("Work session cancelled.");
        }

        workspacePath = selectedPath;
    } else {
        workspacePath = path.resolve(process.cwd());
    }

    workspacePath ||= path.resolve(process.cwd());

    if (effectiveGoal && canRenderSpinner && !noInteractive) {
        const wsCheck = await checkWorkspaceContent(workspacePath, effectiveGoal, canRenderSpinner);
        effectiveGoal = wsCheck.goal;
    }

    // ---------------------------------------------------------------------------
    // Pre-launch confirmation — skip in non-interactive mode (TUI handles its own UX)
    // ---------------------------------------------------------------------------
    if (canRenderSpinner && hasConfiguredSession && !noInteractive) {
        const model = setupConfig.model || "";
        const confirmed = await promptPreLaunchConfirmation(
            canRenderSpinner, effectiveGoal!, workspacePath,
            sessionMode!, maxRuns, timeoutMinutes, model,
        );
        effectiveGoal = confirmed.goal;
        workspacePath = confirmed.workspace;
        maxRuns = confirmed.maxRuns;
        timeoutMinutes = confirmed.timeoutMinutes;
        sessionMode = confirmed.sessionMode;
    }

    const sessionSummary = sessionMode === "time"
        ? `${timeoutMinutes}min time limit`
        : `${maxRuns} runs`;
    logger.plain(pc.gray(`>>> Session: ${sessionSummary}`));

    // ---------------------------------------------------------------------------
    // Pre-flight checks — drift detection + goal clarity (extracted to goal-resolver.ts)
    // ---------------------------------------------------------------------------
    if (effectiveGoal && canRenderSpinner && !noInteractive) {
        effectiveGoal = await runPreFlightChecks(effectiveGoal);
    }

    // ---------------------------------------------------------------------------
    // Dashboard auto-start
    // ---------------------------------------------------------------------------
    if (!noWebFlag) {
        const webPort = setupConfig.dashboardPort || 9001;
        await startDashboard({ webPort });
    }

    const stopGatewayTailer = startGatewayLogTailer();

    // ---------------------------------------------------------------------------
    // Provider health check
    // ---------------------------------------------------------------------------
    {
        const providers = pm.getProviders();
        let healthyCount = 0;
        for (const p of providers) {
            try {
                const ok = await p.healthCheck();
                if (ok) healthyCount++;
            } catch { /* non-critical */ }
        }
        if (healthyCount === 0 && providers.length > 0) {
            log("warn", "No providers passed health check — requests may fail.");
        }
    }

    if (maxRuns > CONFIG.maxRuns) {
        maxRuns = CONFIG.maxRuns;
    }

    if (!canRenderSpinner) {
        log("info", "Start working!");
        log("info", `   Runs: ${maxRuns}`);
        log("info", "");
    }

    // ---------------------------------------------------------------------------
    // Memory & workspace init
    // ---------------------------------------------------------------------------
    await ensureWorkspaceDir(CONFIG.workspaceDir);
    {
        let sessionLog: string;
        let historyLog: string;
        try {
            sessionLog = await rotateAndCreateSessionLog({
                logDir: path.join(os.homedir(), ".openpawl", "logs"),
                prefix: "work-session",
                maxFiles: 10,
            });
        } catch {
            sessionLog = path.join(CONFIG.workspaceDir, "openpawl-debug.log");
        }
        try {
            historyLog = await rotateAndCreateSessionLog({
                logDir: path.join(os.homedir(), ".openpawl", "logs"),
                prefix: "work-history",
                maxFiles: 20,
            });
        } catch {
            historyLog = path.join(CONFIG.workspaceDir, "work_history.log");
        }
        initLogPaths(sessionLog, historyLog);
    }

    const memoryConfig = await loadTeamConfig();
    const selectedMemoryBackend: MemoryBackend =
        memoryConfig?.memory_backend ?? CONFIG.memoryBackend;
    if (selectedMemoryBackend === "local_json") {
        log("info", "   Using local JSON memory backend");
    } else {
        log("info", "   Using embedded LanceDB memory backend");
    }

    const vectorMemory = new VectorMemory(CONFIG.vectorStorePath, selectedMemoryBackend);
    await vectorMemory.init();

    // Auto-prune expired cache entries (async, never blocks startup)
    resetSessionCacheStats();
    resetTokenOptStats();
    const cacheStore = new ResponseCacheStore();
    cacheStore.prune().then((pruned) => {
        if (pruned > 0) log("info", `Pruned ${pruned} expired cache entries`);
    }).catch(() => {});

    // Start provider health monitor for the work session
    const healthMonitor = getHealthMonitor();
    if (healthMonitor) {
        healthMonitor.start();
    }
    const providerMgr = getProviderManager();
    if (providerMgr) {
        providerMgr.resetStats();
    }

    if (clearLegacy) {
        log("warn", "Clearing lesson data is not implemented (delete data/vector_store manually)");
    }

    const analyst = new PostMortemAnalyst(vectorMemory);
    let lastTotalReworks = 0;
    let lastFinalState: Record<string, unknown> | null = null;
    let lastTeamComposition: TeamComposition | undefined;
    const workStats = {
        runs_completed: 0,
        total_lessons_learned: 0,
        longest_run_cycles: 0,
        total_tasks_completed: 0,
        failures: 0,
    };

    async function learnLessonFromFailure(
        runId: number,
        cause: string,
        state: Record<string, unknown> | null,
    ): Promise<void> {
        const stateWithCause = {
            ...(state ?? {}),
            death_reason: cause,
            generation_id: runId,
        } as GraphState;
        const lesson = await analyst.analyzeFailure(stateWithCause);
        workStats.total_lessons_learned += 1;
        const report = analyst.generatePostMortemReport(stateWithCause, lesson);
        logger.plain(report);
    }

    const defaultGoal = getDefaultGoal();

    const teamConfigForValidation = memoryConfig ?? (await loadTeamConfig());
    const result = await validateStartup({
        templateId: teamConfigForValidation?.template,
        maxCycles: CONFIG.maxCycles,
        maxRuns,
    });
    if (!result.ok) {
        throw new FatalSessionError(result.message);
    }

    log("info", pc.dim("💡 Tip: Press Ctrl+C to stop the work session. The managed gateway will be stopped automatically."));

    // ---------------------------------------------------------------------------
    // Display reasoning/thinking in terminal as it arrives
    const reasoningListener = (data: { taskId: string; botId: string; reasoning: string }) => {
        if (canRenderSpinner) {
            const preview = data.reasoning.slice(0, 200).replace(/\n/g, " ");
            clackLog.info(pc.dim(`[${data.botId}] thinking: ${preview}${data.reasoning.length > 200 ? "..." : ""}`));
        }
    };
    workerEvents.on("reasoning", reasoningListener);

    // Display streaming LLM output in terminal — single updating line
    const streamingEnabled = setupConfig.streaming?.enabled !== false && !parsed.noStream;
    const streamChunkListener = streamingEnabled && canRenderSpinner
        ? (() => {
            let lastLine = "";
            return (data: { botId: string; chunk: string }) => {
                const text = (lastLine + data.chunk).replace(/\r/g, "");
                const lines = text.split("\n").filter(l => l.trim());
                lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
                const cols = process.stdout.columns || 80;
                const prefix = `  [${data.botId}] `;
                const maxContent = cols - prefix.length - 1;
                const preview = lastLine.slice(0, maxContent).replace(/[\r\n]/g, "");
                const pad = Math.max(0, cols - prefix.length - preview.length);
                process.stderr.write(`\r${pc.dim(prefix + preview)}${" ".repeat(pad)}`);
            };
        })()
        : null;
    if (streamChunkListener) workerEvents.on("stream-chunk", streamChunkListener);

    // ---------------------------------------------------------------------------
    // Global memory maintenance — prune stale patterns on startup
    // ---------------------------------------------------------------------------
    const vmEmbedderForPrune = vectorMemory.getEmbedder();
    if (vmEmbedderForPrune) {
      try {
        const globalMgr = new GlobalMemoryManager();
        await globalMgr.init(vmEmbedderForPrune);
        const pruner = new GlobalPruner(globalMgr);
        const pruneResult = await pruner.prune();
        const total = pruneResult.patternsRemoved + pruneResult.lessonsRemoved + pruneResult.edgesRemoved;
        if (total > 0) {
          log("info", `Global memory pruned: ${pruneResult.patternsRemoved} patterns, ${pruneResult.lessonsRemoved} lessons, ${pruneResult.edgesRemoved} edges`);
        }
      } catch (pruneErr) {
        log("warn", `Global memory pruning failed: ${pruneErr}`);
      }
    }

    // Session recording — always on, async, never blocks
    const sessionRecordStart = Date.now();
    const replaySessionId = `work-${sessionRecordStart}`;
    const recorder = new SessionRecorder(replaySessionId);
    setActiveRecorder(recorder);
    createSession(replaySessionId, effectiveGoal || "(no goal)", []);

    // Main run loop
    // ---------------------------------------------------------------------------
    for (let runId = 1; runId <= maxRuns; runId++) {
        recorder.setRunIndex(runId);
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

            // Wire webhook approval provider if --async mode with configured webhook
            let webhookProvider: ReturnType<typeof createWebhookApprovalProvider> | undefined;
            if (asyncMode && CONFIG.webhookApprovalUrl && CONFIG.webhookApprovalSecret) {
                const webhookCfg: WebhookApprovalConfig = {
                    url: CONFIG.webhookApprovalUrl,
                    secret: CONFIG.webhookApprovalSecret,
                    provider: CONFIG.webhookApprovalProvider as "slack" | "generic",
                    timeoutSeconds: asyncTimeout > 0 ? asyncTimeout * 60 : CONFIG.webhookApprovalTimeoutSeconds,
                    retryAttempts: CONFIG.webhookApprovalRetryAttempts,
                    callbackBaseUrl: `http://localhost:${setupConfig.dashboardPort || 9001}`,
                    sessionId: `work-${Date.now()}`,
                };
                webhookProvider = createWebhookApprovalProvider(webhookCfg);
                log("info", `Webhook approvals: ${webhookCfg.url}`);
                log("info", `Callback: POST ${webhookCfg.callbackBaseUrl}/webhook/approval`);
                // Keep web server running for callbacks
                noWebFlag = false;
            } else if (asyncMode) {
                log("warn", "--async requires webhookApproval.url and webhookApproval.secret in ~/.openpawl/config.json");
            }

            // Resolve team composition mode: CLI flag > config > default "manual"
            const teamMode = parsed.teamMode ?? teamConfig?.team_mode ?? "manual";
            let teamComposition: TeamComposition | undefined;

            if (teamMode === "template" && parsed.templateId) {
                // Template composition mode — load template and build composition
                const { LocalTemplateStore } = await import("./templates/local-store.js");
                const { getSeedTemplate } = await import("./templates/seeds/index.js");
                const templateStore = new LocalTemplateStore();
                const tmpl = await templateStore.get(parsed.templateId) ?? getSeedTemplate(parsed.templateId);
                if (tmpl) {
                    if (canRenderSpinner && runId === 1) {
                        logger.info(`Using template: ${tmpl.name} (${tmpl.agents.length} agents)`);
                        if (tmpl.defaultGoalTemplate) {
                            logger.plain(pc.dim(`  Goal hint: ${tmpl.defaultGoalTemplate}`));
                        }
                    }
                    teamComposition = {
                        mode: "template",
                        activeAgents: tmpl.agents.map((a) => ({
                            role: a.role,
                            reason: `Template agent: ${tmpl.name}`,
                            confidence: a.compositionRules?.required ? 1.0 : 0.8,
                        })),
                        excludedAgents: [],
                        overallConfidence: 0.9,
                        analyzedGoal: goal,
                        analyzedAt: new Date().toISOString(),
                    };
                } else {
                    log("warn", `Template "${parsed.templateId}" not found. Falling back to manual mode.`);
                }
            } else if (teamMode === "autonomous") {
                // Build custom inclusion rules from registered agents
                const customRules = buildCustomCompositionRules();
                teamComposition = analyzeGoal(goal, { runCount: maxRuns, customRules });
                if (canRenderSpinner && runId === 1 && !noInteractive) {
                    renderCompositionTable(teamComposition);
                    const compAction = await promptCompositionAction(teamComposition);
                    if (compAction.action === "manual") {
                        teamComposition = undefined;
                    } else if (compAction.overrides?.length) {
                        teamComposition = applyOverrides(teamComposition, compAction.overrides);
                    }
                }
            }

            const orchestration = createTeamOrchestration({
                team, workspacePath, autoApprove, signal: sessionAbort.signal,
                ...(webhookProvider ? { partialApprovalProvider: webhookProvider } : {}),
                teamComposition,
            });
            const runStartTime = Date.now();

            // Telemetry init (legacy canvas gateway — non-critical)
            if (runId === 1) {
                try {
                    const { initCanvasTelemetry, getCanvasTelemetry } = await import("./core/canvas-telemetry.js");
                    const telemetryConnected = await initCanvasTelemetry();
                    if (telemetryConnected) {
                        getCanvasTelemetry().sendSessionStart(goal);
                        logger.success(">>> WebSocket Telemetry: CONNECTED");
                    }
                    // No warning on failure — canvas telemetry is optional legacy feature
                } catch {
                    // Canvas telemetry unavailable — silently skip
                }
            }

            let finalState: Record<string, unknown>;
            if (canRenderSpinner) {
                const sPlan = spinner();
                const startTime = Date.now();
                sPlan.start(randomPhrase("plan"));

                // Track cumulative token usage from LLM events
                let totalTokens = 0;
                let spinnerStopped = false;
                const { llmEvents } = await import("./core/llm-events.js");
                const { coordinatorEvents } = await import("./core/coordinator-events.js");

                const formatTokens = (n: number): string =>
                    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

                const updateSpinnerMessage = (detail: string) => {
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    const tokenStr = totalTokens > 0 ? `, ${formatTokens(totalTokens)} tokens` : "";
                    sPlan.message(`🧠 ${detail} (${elapsed}s${tokenStr})`);
                };

                const onLlmLog = (entry: { action: string; meta?: Record<string, unknown> }) => {
                    if (entry.action === "request_end" && entry.meta) {
                        totalTokens += ((entry.meta.promptTokens as number) ?? 0) + ((entry.meta.completionTokens as number) ?? 0);
                    }
                };
                llmEvents.on("log", onLlmLog);

                const heartbeatInterval = setInterval(() => {
                    if (!spinnerStopped) {
                        updateSpinnerMessage("Planning");
                    }
                }, 5000);

                const stopSpinner = (msg: string) => {
                    if (!spinnerStopped) {
                        clearInterval(heartbeatInterval);
                        llmEvents.off("log", onLlmLog);
                        coordinatorEvents.off("progress", onCoordinatorProgress);
                        sPlan.stop(msg);
                        spinnerStopped = true;
                    }
                };

                const onCoordinatorProgress = (data: { step: string; detail: string }) => {
                    if (!spinnerStopped) {
                        if (data.step === "preview_ready") {
                            stopSpinner("Sprint preview ready");
                        } else {
                            updateSpinnerMessage(data.detail);
                        }
                    }
                };
                coordinatorEvents.on("progress", onCoordinatorProgress);

                try {
                    let bridge: { sendNodeEvent: (n: string, s: Record<string, unknown>) => void; sendCycleStart: (c: number, m: number) => void; sendSessionComplete: () => void; sendError: (m: string) => void } | null = null;
                    try {
                        const { getDashboardBridge } = await import("./core/dashboard-bridge.js");
                        bridge = getDashboardBridge();
                    } catch {
                        // Bridge not initialized
                    }

                    let lastCycle = 0;

                    // Nodes that run before workers — spinner is safe during these
                    const PLANNING_NODES = new Set([
                        "memory_retrieval", "sprint_planning", "system_design",
                        "rfc_phase", "coordinator",
                    ]);

                    const streamFn = async () => {
                        let result: Record<string, unknown> = {};
                        for await (const chunk of orchestration.stream({
                            userGoal: goal,
                            ancestralLessons: priorLessons,
                            projectContext: projectContextStr,
                            maxRuns,
                            timeoutMinutes,
                            skipPreview: noPreview || runId > 1,
                            runId,
                        })) {
                            const nodeState = chunk as Record<string, unknown>;
                            const nodeName = (nodeState.__node__ as string) ?? "unknown";
                            if (!nodeName || nodeName === "unknown") continue;
                            result = nodeState;

                            // Stop spinner once we leave the planning phase
                            if (!spinnerStopped && !PLANNING_NODES.has(nodeName)) {
                                stopSpinner(nodeName === "preview_gate"
                                    ? "Sprint preview ready"
                                    : `Planning complete — ${nodeName}`);
                            }

                            if (!spinnerStopped) {
                                updateSpinnerMessage(nodeName);
                            }

                            const cycle = (nodeState.cycle_count as number) ?? 0;
                            if (cycle > lastCycle) {
                                lastCycle = cycle;
                                bridge?.sendCycleStart(cycle, maxRuns);
                            }

                            bridge?.sendNodeEvent(nodeName, nodeState);
                        }
                        bridge?.sendSessionComplete();
                        return result;
                    };

                    finalState = (await (isDebugMode()
                        ? streamFn()
                        : withConsoleRedirect(streamFn))) as Record<string, unknown>;
                } catch (error) {
                    stopSpinner("✗ Error");
                    const message =
                        error instanceof Error ? error.message : String(error);

                    if (sessionAbort.signal.aborted || message === "Aborted") {
                        if (!spinnerStopped) sPlan.stop("Work session cancelled by user.");
                        break;
                    }

                    // Use friendly error formatting for provider errors
                    const { ProviderError } = await import("./providers/types.js");
                    const { formatError } = await import("./core/errors.js");
                    if (error instanceof ProviderError) {
                        sPlan.stop("✗ Provider error");
                        const friendly = formatError(error.code, error.provider, `${error.code} (${error.statusCode ?? "N/A"})`);
                        logger.plain("\n" + friendly);
                        clearSessionConfig();
                        throw new FatalSessionError(friendly);
                    }

                    sPlan.stop(
                        `✗ Coordinator failed to decompose goal: ${message}`,
                    );
                    const isFatal =
                        /HTTP [45]\d\d|ECONNREFUSED|ENOTFOUND|404|Not Found|fetch failed/i.test(message);
                    if (isFatal) {
                        const friendly = formatError("CONNECTION_FAILED", "your provider", message.split("\n")[0]);
                        clearSessionConfig();
                        throw new FatalSessionError(friendly);
                    }
                    throw error;
                }

                const taskQueue = (finalState.task_queue ?? []) as Record<string, unknown>[];
                if (!spinnerStopped) {
                    stopSpinner(`✅ Goal decomposed into ${taskQueue.length} tasks.`);
                }

                const executionMessages = (finalState.messages ?? []) as string[];
                for (const msg of executionMessages) {
                    // Skip verbose messages that clutter the TUI
                    if (msg.startsWith("🎤 STAND-UP")) continue;
                    if (msg.startsWith("OpenPawl - Run")) continue;
                    if (msg.startsWith("Work session started")) continue;
                    if (msg.startsWith("🔄 Coder")) continue;

                    // Collapse replanning detail — show header, dim the bullet points
                    if (msg.includes("Plan infeasible") || msg.includes("Coordinator is revising")) {
                        const lines = msg.split("\n");
                        const header = lines[0];
                        clackLog.warn(header);
                        if (lines.length > 1) {
                            clackLog.info(pc.dim(lines.slice(1).join("\n")));
                        }
                        continue;
                    }

                    if (msg.startsWith("▶")) clackLog.step(msg);
                    else if (msg.startsWith("✅")) clackLog.success(msg);
                    else if (msg.startsWith("❌")) clackLog.error(msg);
                    else if (msg.startsWith("👀")) clackLog.info(msg);
                    else if (msg.startsWith("🔧")) clackLog.warn(msg);
                    else clackLog.info(msg);
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
                            const taskResult = (t.result ?? null) as Record<string, unknown> | null;
                            const rawReason =
                                taskResult?.output != null
                                    ? String(taskResult.output).trim()
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
                let bridge: { sendNodeEvent: (n: string, s: Record<string, unknown>) => void; sendCycleStart: (c: number, m: number) => void; sendSessionComplete: () => void } | null = null;
                try {
                    const { getDashboardBridge } = await import("./core/dashboard-bridge.js");
                    bridge = getDashboardBridge();
                } catch { /* no bridge */ }

                let lastCycleAlt = 0;
                finalState = {} as Record<string, unknown>;
                for await (const chunk of orchestration.stream({
                    userGoal: goal,
                    ancestralLessons: priorLessons,
                    maxRuns,
                    timeoutMinutes,
                    skipPreview: noPreview || runId > 1,
                    runId,
                })) {
                    const nodeState = chunk as Record<string, unknown>;
                    const nodeName = (nodeState.__node__ as string) ?? "unknown";
                    if (!nodeName || nodeName === "unknown") continue;
                    finalState = nodeState;

                    const cycle = (nodeState.cycle_count as number) ?? 0;
                    if (cycle > lastCycleAlt) {
                        lastCycleAlt = cycle;
                        bridge?.sendCycleStart(cycle, maxRuns);
                    }
                    bridge?.sendNodeEvent(nodeName, nodeState);
                }
                bridge?.sendSessionComplete();
            }

            // Count from task_queue (authoritative) with bot_stats as fallback
            const runTaskQueue = ((finalState as Record<string, unknown>).task_queue ?? []) as Record<string, unknown>[];
            const totalDone = runTaskQueue.filter(t => (t.status as string) === "completed").length;
            const totalFailed = runTaskQueue.filter(t => (t.status as string) === "failed").length;
            const botStats = (finalState as Record<string, unknown>)
                .bot_stats as Record<string, Record<string, unknown>> | null;
            lastTotalReworks = botStats
                ? Object.values(botStats).reduce(
                      (s, x) => s + ((x?.reworks_triggered as number) ?? 0),
                      0,
                  )
                : 0;
            lastFinalState = finalState;
            lastTeamComposition = teamComposition;

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
                await learnLessonFromFailure(runId, cause, finalState);
                log("info", `Lesson learned. Proceeding to run ${runId + 1}`);
                log("info", "");
            } else if (failed && maxRuns === 1) {
                log(
                    "warn",
                    `Work session completed with failures: ${totalDone} done, ${totalFailed} failed`,
                );
                break;
            } else {
                log("info", `Run ${runId} completed — ${totalDone} tasks done, ${totalFailed} failed, ${(finalState as Record<string, unknown>).cycle_count} cycle(s)`);
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

                const shouldRunPostMortem = !teamComposition || teamComposition.activeAgents.some(a => a.role === "post_mortem");
                if (shouldRunPostMortem) {
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
                }

                // Persist success patterns extracted during approval
                const vmDb = vectorMemory.getDb();
                const vmEmbedder = vectorMemory.getEmbedder();
                if (vmDb && vmEmbedder) {
                    try {
                        const successStore = new SuccessPatternStore(vmDb, vmEmbedder);
                        await successStore.init();
                        const rawPatterns = (finalState as Record<string, unknown>).new_success_patterns as string[] ?? [];
                        let storedCount = 0;
                        for (const raw of rawPatterns) {
                            try {
                                const pattern = JSON.parse(raw) as SuccessPattern;
                                pattern.sessionId = `work-${Date.now()}`;
                                pattern.runIndex = runId;
                                void successStore.upsert(pattern).catch(() => {});
                                storedCount++;
                            } catch {
                                // Skip malformed patterns
                            }
                        }

                        // Record learning curve
                        const lcStore = new LearningCurveStore(vmDb);
                        await lcStore.init();
                        const approvalStats = (finalState as Record<string, unknown>).approval_stats as Record<string, unknown> ?? {};
                        const avgConf = (finalState as Record<string, unknown>).average_confidence as number ?? 0;
                        await lcStore.record(`work-${Date.now()}`, {
                            runIndex: runId,
                            averageConfidence: avgConf,
                            autoApprovedCount: (approvalStats.autoApprovedCount as number) ?? 0,
                            patternsUsed: 0,
                            newPatternsStored: storedCount,
                        });

                        // Prune stale patterns on subsequent runs
                        if (runId > 1) {
                            const qualityStore = new PatternQualityStore(vmDb);
                            await qualityStore.init();
                            await pruneStalePatterns(successStore, qualityStore);
                        }

                        if (storedCount > 0 && canRenderSpinner) {
                            logger.success(`📚 Stored ${storedCount} success pattern(s)`);
                        }

                        // Auto-promote qualifying patterns to global memory
                        try {
                            const globalManager = new GlobalMemoryManager();
                            await globalManager.init(vmEmbedder);
                            const qualityStore = new PatternQualityStore(vmDb);
                            await qualityStore.init();
                            const promoter = new PromotionEngine(globalManager, successStore, qualityStore, vmEmbedder);
                            const promoResult = await promoter.autoPromote(`work-${Date.now()}`);
                            if (promoResult.promoted.length > 0 && canRenderSpinner) {
                                logger.success(`🌐 Promoted ${promoResult.promoted.length} pattern(s) to global memory`);
                            }
                        } catch (promoErr) {
                            log("warn", `Global memory promotion failed: ${promoErr}`);
                        }

                        // Finalize sprint scratchpad — confirm or reject provisional memories
                        try {
                            const sprintId = `work-${runId}`;
                            const scratchpad = vmDb && vmEmbedder
                                ? getSprintScratchpad(sprintId, vmDb, vmEmbedder)
                                : null;
                            const globalMgr = new GlobalMemoryManager();
                            await globalMgr.init(vmEmbedder);
                            const finResult = await finalizeSprintMemories(
                                sprintId,
                                !failed,
                                globalMgr,
                                scratchpad,
                            );
                            if ((finResult.confirmed > 0 || finResult.removed > 0) && canRenderSpinner) {
                                if (finResult.confirmed > 0) {
                                    logger.success(`📝 Confirmed ${finResult.confirmed} provisional memory/memories`);
                                }
                                if (finResult.removed > 0) {
                                    logger.success(`🗑️ Removed ${finResult.removed} provisional memory/memories from failed sprint`);
                                }
                            }
                        } catch (finErr) {
                            log("warn", `Sprint memory finalization failed: ${finErr}`);
                        }

                        // Build/update agent performance profiles
                        try {
                            const pStore = orchestration.profileStore;
                            const profileBuilder = new ProfileBuilder(pStore);
                            const taskQueue = ((finalState as Record<string, unknown>).task_queue ?? []) as Array<Record<string, unknown>>;
                            const completedResults: CompletedTaskResult[] = [];
                            for (const t of taskQueue) {
                                const status = t.status as string;
                                if (status !== "completed" && status !== "failed") continue;
                                const result = t.result as Record<string, unknown> | null;
                                const botId = (t.assigned_to as string) ?? "";
                                const bot = team.find((b) => b.id === botId);
                                const roleId = bot?.role_id ?? botId;
                                const conf = result?.confidence as Record<string, unknown> | undefined;
                                completedResults.push({
                                    taskId: (t.task_id as string) ?? "",
                                    agentRole: roleId,
                                    description: (t.description as string) ?? "",
                                    success: status === "completed",
                                    confidence: typeof conf?.score === "number" ? (conf.score as number) : (result?.quality_score as number ?? 0),
                                    reworkCount: (t.retry_count as number) ?? 0,
                                });
                            }
                            if (completedResults.length > 0) {
                                const updatedProfiles = await profileBuilder.buildFromTaskResults(completedResults);
                                for (const profile of updatedProfiles) {
                                    const alert = checkDegradation(profile);
                                    if (alert && canRenderSpinner) {
                                        logger.warn(`⚠️ Performance degradation: ${alert.agentRole} score dropped from ${(alert.previousScore * 100).toFixed(0)}% to ${(alert.currentScore * 100).toFixed(0)}%`);
                                    }
                                }
                                if (canRenderSpinner) {
                                    logger.success(`📊 Updated ${updatedProfiles.length} agent profile(s)`);
                                }
                            }
                        } catch (profileErr) {
                            log("warn", `Agent profile update failed: ${profileErr}`);
                        }

                        // Record composition history if autonomous mode was used
                        if (teamComposition) {
                            try {
                                const { CompositionHistoryStore } = await import("./agents/composition/history.js");
                                const compStore = new CompositionHistoryStore();
                                await compStore.init(vmDb);
                                await compStore.record({
                                    id: `comp-${Date.now()}-${runId}`,
                                    composition: teamComposition,
                                    overrides: [],
                                    goal,
                                    runId,
                                    success: !failed,
                                    createdAt: new Date().toISOString(),
                                });
                            } catch (compErr) {
                                log("warn", `Composition history recording failed: ${compErr}`);
                            }
                        }
                    } catch (err) {
                        log("warn", `Failed to persist success patterns: ${err}`);
                    }
                }

                log("info", "");

                // Inter-run summary for multi-run sessions
                if (maxRuns > 1 && runId < maxRuns && canRenderSpinner) {
                    try {
                        const avgConf = (finalState as Record<string, unknown>).average_confidence as number ?? 0;
                        const newLessonsCount = ((finalState as Record<string, unknown>).new_success_patterns as string[] ?? []).length;
                        logger.plain(renderInterRunSummary({
                            completedRun: runId,
                            nextRun: runId + 1,
                            averageConfidence: avgConf,
                            targetConfidence: 0.87,
                            newLessons: newLessonsCount,
                        }));
                    } catch {
                        // Never block on inter-run summary failure
                    }
                }

                if (maxRuns === 1) break;
            }
        } catch (err) {
            workStats.runs_completed = runId;

            if ((err as NodeJS.ErrnoException).code === "SIGINT" || sessionAbort.signal.aborted || (err instanceof Error && err.message === "Aborted")) {
                log("warn", "\nWork session interrupted by user");
                break;
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            const isFatal =
                /HTTP [45]\d\d|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|WebSocket closed|fetch failed/i.test(errMsg);

            if (isFatal) {
                clearSessionConfig();
                throw new FatalSessionError(`Fatal provider error: ${errMsg}\nRun \`openpawl setup\` to reconfigure providers or \`openpawl check\` to diagnose.`);
            }

            // Retryable errors: planning timeouts, decomposition failures, transient LLM errors
            const isRetryable = /timed out|planning failed|decompos/i.test(errMsg);
            if (isRetryable && runId < maxRuns) {
                workStats.failures += 1;
                log("warn", `Run ${runId} failed (retryable): ${errMsg}`);
                log("info", "Running post-mortem analysis...");
                try {
                    await learnLessonFromFailure(runId, errMsg, null);
                } catch {
                    log("warn", "Post-mortem analysis failed, continuing to next run");
                }
                log("info", `Proceeding to run ${runId + 1}`);
                continue;
            }

            log("error", `Fatal error in run ${runId}: ${err}`);
            logger.error(String(err));
            break;
        }
    }

    // ---------------------------------------------------------------------------
    // Session cleanup
    // ---------------------------------------------------------------------------
    // Dispose any remaining sandbox runtimes from parallel branches
    const { disposeAllRuntimes } = await import("./tools/sandbox-registry.js");
    disposeAllRuntimes();

    workerEvents.off("reasoning", reasoningListener);
    if (streamChunkListener) {
        workerEvents.off("stream-chunk", streamChunkListener);
        // Clear the single-line stream preview
        const cols = process.stdout.columns || 80;
        process.stderr.write(`\r${" ".repeat(cols)}\r`);
    }
    stopGatewayTailer();
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

    // Finalize recording
    recorder.stop();
    setActiveRecorder(null);
    finalizeSession(replaySessionId, {
      totalRuns: maxRuns,
      totalCostUSD: 0,
      averageConfidence: 0,
    }).catch(() => {});

    // Auto-export audit trail (async, non-blocking)
    if (lastFinalState) {
      autoExportAudit(replaySessionId, maxRuns, lastFinalState as Record<string, unknown>, sessionRecordStart, []).catch(() => {});
    }

    // Auto-generate CONTEXT.md (async, non-blocking)
    if (lastFinalState) {
      autoGenerateContext(
        replaySessionId,
        effectiveGoal || "(no goal)",
        lastFinalState as Record<string, unknown>,
        workspacePath,
      ).catch(() => {});
    }

    // Non-blocking vibe score calculation
    if (lastFinalState) {
      (async () => {
        try {
          const { calculateScore, buildScoreInputFromState, detectPatterns, selectTip, VibeScoreStore } = await import("./score/index.js");
          const scoreInput = buildScoreInputFromState(lastFinalState as Record<string, unknown>, [], [], []);
          const result = calculateScore(scoreInput);
          const patterns = detectPatterns(result, scoreInput);
          const tip = selectTip(result, scoreInput);
          const todayStr = new Date().toISOString().slice(0, 10);

          const vmDb = vectorMemory.getDb?.();
          if (vmDb) {
            const store = new VibeScoreStore();
            await store.init(vmDb);
            await store.upsert({
              id: `score-${todayStr}`,
              date: todayStr,
              overall: result.overall,
              teamTrust: result.dimensions.team_trust.score,
              reviewEngagement: result.dimensions.review_engagement.score,
              warningResponse: result.dimensions.warning_response.score,
              confidenceAlignment: result.dimensions.confidence_alignment.score,
              sessionCount: 1,
              eventsJson: JSON.stringify(result.events),
              patternsJson: JSON.stringify(patterns),
              tip,
              computedAt: result.computedAt,
            });
          }
        } catch {
          // Score calculation is non-critical
        }
      })();
    }

    const shouldRunRetro = !lastTeamComposition || lastTeamComposition.activeAgents.some(a => a.role === "retrospective");
    if (lastTotalReworks > 0 && lastFinalState && shouldRunRetro) {
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

    try {
        const { getDashboardBridge } = await import("./core/dashboard-bridge.js");
        getDashboardBridge().disconnect();
    } catch { /* bridge may not have been initialized */ }
    // Dashboard daemon is intentionally NOT stopped here — it persists
    // across work sessions. Stop it explicitly with `openpawl web stop`.

    // ---------------------------------------------------------------------------
    // Post-session interactive menu
    // ---------------------------------------------------------------------------
    const { showPostSessionMenu } = await import("./work-runner/post-session-menu.js");
    const dashboardPort = setupConfig.dashboardPort || 9001;
    const menuResult = await showPostSessionMenu({
        noInteractive,
        dashboardPort,
    });

    if (menuResult.choice === "continue") {
        // Re-run with same config
        await runWork({
            args,
            goal: effectiveGoal || undefined,
            openDashboard: !noWebFlag,
            noWeb: noWebFlag,
        });
        return;
    }

    if (menuResult.choice === "new-goal" && menuResult.newGoal) {
        await runWork({
            args,
            goal: menuResult.newGoal,
            openDashboard: !noWebFlag,
            noWeb: noWebFlag,
        });
        return;
    }

    // "exit" — clean exit
    if (canRenderSpinner) {
        const { outro } = await import("@clack/prompts");
        outro("Done! Run openpawl work whenever you're ready.");
    }
  } catch (err) {
    if (err instanceof UserCancelError) {
      cancel(err.message);
      process.exit(0);
    }
    if (err instanceof FatalSessionError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
