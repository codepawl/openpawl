/**
 * Work Runner - Team orchestration sessions with lesson learning.
 */

import { createTeamOrchestration } from "./core/simulation.js";
import { analyzeGoal } from "./agents/composition/analyzer.js";
import type { TeamComposition } from "./agents/composition/types.js";
import type { AgentInclusionRule } from "./agents/composition/rules.js";
import { renderCompositionTable, promptCompositionAction, applyOverrides } from "./cli/composition-preview.js";
import { AgentRegistryStore } from "./agents/registry/index.js";
import { SessionRecorder, setActiveRecorder, createSession, finalizeSession } from "./replay/index.js";
import { buildAuditTrail, renderAuditMarkdown } from "./audit/index.js";
import type { BotDefinition } from "./core/bot-definitions.js";
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
import { appendFile } from "node:fs/promises";
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
import { resolveGoalFromFile, checkWorkspaceContent, promptGoalChoice } from "./work-runner/goal-resolver.js";
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

let DEBUG_LOG_PATH = "";
let WORK_HISTORY_LOG_PATH = "";

function log(level: "info" | "warn" | "error", msg: string): void {
    const levelUp = level.toUpperCase() as "INFO" | "WARN" | "ERROR";
    if (level === "info") logger.info(msg);
    else if (level === "warn") logger.warn(msg);
    else logger.error(msg);
    if (WORK_HISTORY_LOG_PATH) {
        appendFile(
            WORK_HISTORY_LOG_PATH,
            logger.plainLine(levelUp, msg) + "\n",
        ).catch(() => {});
    }
}

async function withConsoleRedirect<T>(fn: () => Promise<T> | T): Promise<T> {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    const write = (level: string, args: unknown[]): void => {
        const line = `[${new Date().toISOString()}] ${level}: ${args
            .map((a) => String(a))
            .join(" ")}`;
        originalLog(line);
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

/** Auto-export audit trail to markdown after run completes. Never blocks. */
async function autoExportAudit(
  sessionId: string,
  runIndex: number,
  finalState: Record<string, unknown>,
  startTime: number,
  team: BotDefinition[],
): Promise<void> {
  try {
    const audit = await buildAuditTrail(sessionId, runIndex, finalState, startTime, Date.now(), team);
    const md = renderAuditMarkdown(audit);
    const { writeFile, mkdir } = await import("node:fs/promises");
    const sessionDir = path.join(os.homedir(), ".teamclaw", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "audit.md"), md, "utf-8");
  } catch {
    // Non-critical — auto-export failure should never affect the session
  }
}

/** Auto-generate CONTEXT.md handoff after session completes. Never blocks or throws. */
async function autoGenerateContext(
  sessionId: string,
  goal: string,
  finalState: Record<string, unknown>,
  workspacePath: string,
): Promise<void> {
  try {
    const { readGlobalConfigWithDefaults: readCfg } = await import("./core/global-config.js");
    const cfg = readCfg();
    if (cfg.handoff?.autoGenerate === false) return;

    const { buildHandoffData, renderContextMarkdown } = await import("./handoff/index.js");

    // Retrieve active decisions (best-effort)
    let activeDecisions: import("./journal/types.js").Decision[] = [];
    try {
      const { DecisionStore } = await import("./journal/store.js");
      const { GlobalMemoryManager } = await import("./memory/global/store.js");
      const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
      await vm.init();
      const embedder = vm.getEmbedder();
      if (embedder) {
        const gmm = new GlobalMemoryManager();
        await gmm.init(embedder);
        const db = gmm.getDb();
        if (db) {
          const store = new DecisionStore();
          await store.init(db);
          const recent = await store.getRecentDecisions(30);
          activeDecisions = recent.filter((d) => d.status === "active");
        }
      }
    } catch {
      // Non-critical
    }

    const taskQueue = (finalState.task_queue ?? []) as Array<Record<string, unknown>>;
    const nextSprintBacklog = (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>;
    const promotedThisRun = (finalState.promoted_this_run ?? []) as string[];
    const agentProfiles = (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>;
    const rfcDocument = (finalState.rfc_document as string) ?? null;

    const data = buildHandoffData({
      sessionId,
      projectPath: workspacePath,
      goal,
      taskQueue,
      nextSprintBacklog,
      promotedThisRun,
      agentProfiles,
      activeDecisions: activeDecisions as never[],
      rfcDocument,
    });

    const markdown = renderContextMarkdown(data);

    const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises");

    // Write to workspace
    const outputPath = path.resolve(workspacePath, cfg.handoff?.outputPath ?? "./CONTEXT.md");
    await wf(outputPath, markdown, "utf-8");

    // Timestamped copy in session dir
    const sessionDir = path.join(os.homedir(), ".teamclaw", "sessions", sessionId);
    await mkd(sessionDir, { recursive: true });
    await wf(path.join(sessionDir, "CONTEXT.md"), markdown, "utf-8");

    // Git commit if configured
    if (cfg.handoff?.gitCommit) {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`git add "${outputPath}"`, { stdio: "ignore", cwd: workspacePath });
        execSync(`git commit -m "docs: auto-generate CONTEXT.md handoff"`, { stdio: "ignore", cwd: workspacePath });
      } catch {
        // Never fail loudly
      }
    }
  } catch {
    // Auto-generation must never block the session
  }
}

/** Build composition inclusion rules from registered custom agents. */
function buildCustomCompositionRules(): AgentInclusionRule[] {
    try {
        const store = new AgentRegistryStore();
        const defs = store.loadAllSync();
        return defs
            .filter((d) => d.compositionRules)
            .map((d) => ({
                role: d.role,
                required: d.compositionRules?.required ?? false,
                keywords: d.compositionRules?.includeKeywords ?? [],
                negativeKeywords: d.compositionRules?.excludeKeywords ?? [],
                description: d.description,
            }));
    } catch {
        return [];
    }
}

export async function runWork(
    input: string[] | { args?: string[]; goal?: string; openDashboard?: boolean; noWeb?: boolean } = [],
): Promise<void> {
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
        throw new Error("No LLM providers configured. Run `teamclaw setup` or set an API key env var.");
    }

    setDebugMode(setupConfig.debugMode ?? CONFIG.debugMode ?? false);

    // ---------------------------------------------------------------------------
    // Session briefing — show "previously on TeamClaw" before goal prompt
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
                cancel(`Work session cancelled: file not found or unsupported format: ${goalChoice.value}`);
                process.exit(1);
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
    } else if (canRenderSpinner) {
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

    workspacePath ||= path.resolve(process.cwd());

    if (effectiveGoal && canRenderSpinner) {
        const wsCheck = await checkWorkspaceContent(workspacePath, effectiveGoal, canRenderSpinner);
        effectiveGoal = wsCheck.goal;
    }

    // ---------------------------------------------------------------------------
    // Pre-launch confirmation
    // ---------------------------------------------------------------------------
    if (canRenderSpinner && hasConfiguredSession) {
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
    // Pre-flight checks — drift detection + goal clarity run in parallel
    // ---------------------------------------------------------------------------
    if (effectiveGoal && canRenderSpinner) {
        // Capture narrowed goal for closures
        const goalForChecks: string = effectiveGoal;

        // Run both checks concurrently
        const runDriftCheck = async (): Promise<import("./drift/types.js").DriftResult | null> => {
            try {
                const { detectDrift } = await import("./drift/detector.js");
                const { DecisionStore } = await import("./journal/store.js");
                const { GlobalMemoryManager } = await import("./memory/global/store.js");

                const vmForDrift = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
                await vmForDrift.init();
                const embedderForDrift = vmForDrift.getEmbedder();

                let decisions: import("./journal/types.js").Decision[] = [];
                if (embedderForDrift) {
                    const gmDrift = new GlobalMemoryManager();
                    await gmDrift.init(embedderForDrift);
                    const dbDrift = gmDrift.getDb();
                    if (dbDrift) {
                        const dStore = new DecisionStore();
                        await dStore.init(dbDrift);
                        decisions = await dStore.getAll();
                    }
                }

                return detectDrift(goalForChecks, decisions);
            } catch {
                return null;
            }
        };

        const runClarityCheck = async (): Promise<import("./clarity/types.js").ClarityResult | null> => {
            try {
                const { analyzeClarity } = await import("./clarity/analyzer.js");
                return analyzeClarity(goalForChecks);
            } catch {
                return null;
            }
        };

        const [driftResult, clarityResult] = await Promise.all([
            runDriftCheck(),
            runClarityCheck(),
        ]);

        // Surface combined results if both have issues
        const hasDriftIssues = driftResult?.hasDrift === true;
        const hasClarityIssues = clarityResult && !clarityResult.isClear;

        if (hasDriftIssues && hasClarityIssues) {
            // Show both sets of issues together
            const { select, text: clackText, isCancel: clackIsCancel } = await import("@clack/prompts");

            logger.plain(`\n⚠️  ${pc.yellow("Goal clarity issues:")}`);
            for (const issue of clarityResult.issues) {
                const badge = issue.severity === "blocking"
                    ? pc.red("[blocking]")
                    : pc.yellow("[advisory]");
                logger.plain(`  - ${badge} ${issue.question}`);
            }

            const icon = driftResult.severity === "hard" ? "🚨" : "⚠️";
            logger.plain(`\n${icon} ${pc.yellow("Drift conflicts:")}`);
            for (const conflict of driftResult.conflicts) {
                logger.plain(`  - ${conflict.explanation}`);
            }

            const hasBlocking = clarityResult.issues.some((i) => i.severity === "blocking")
                || driftResult.severity === "hard";

            if (hasBlocking) {
                logger.plain(pc.red("\nBlocking issues detected — must be resolved before proceeding."));
            }

            const choice = await select({
                message: "Both clarity and drift issues found. How would you like to proceed?",
                options: [
                    { label: "Rephrase my goal", value: "rephrase" },
                    { label: "Proceed anyway", value: "proceed" },
                    { label: "Abort", value: "abort" },
                ],
            });

            if (clackIsCancel(choice) || choice === "abort") {
                cancel("Work session cancelled.");
                process.exit(0);
            }

            if (choice === "rephrase") {
                const newGoal = await clackText({
                    message: "Enter your revised goal:",
                    placeholder: effectiveGoal,
                });
                if (clackIsCancel(newGoal) || !newGoal) {
                    cancel("Work session cancelled.");
                    process.exit(0);
                }
                effectiveGoal = String(newGoal).trim();
                logger.plain(pc.green("✓ Goal updated. Proceeding to decomposition."));
            }
            // choice === "proceed" → continue with original goal
        } else {
            // Handle drift issues only
            if (hasDriftIssues && driftResult) {
                let driftRetries = 0;
                const MAX_DRIFT_RETRIES = 3;
                let goalToCheck = effectiveGoal;

                // Re-run drift detection in a loop only if user adjusts goal
                let currentDriftResult: import("./drift/types.js").DriftResult | null = driftResult;

                while (currentDriftResult?.hasDrift) {
                    const { select, text: clackText, isCancel: clackIsCancel } = await import("@clack/prompts");

                    const dIcon = currentDriftResult.severity === "hard" ? "🚨" : "⚠";
                    const dLabel = currentDriftResult.severity === "hard" ? "Strong drift detected" : "Drift detected";
                    logger.plain(`\n${dIcon} ${pc.yellow(`${dLabel} — ${currentDriftResult.conflicts.length} conflict(s) with past decisions`)}`);

                    const hasPermanent = currentDriftResult.conflicts.some((c) => c.decision.permanent);

                    for (const conflict of currentDriftResult.conflicts) {
                        const d = conflict.decision;
                        const date = new Date(d.capturedAt).toISOString().slice(0, 10);
                        const lockIcon = d.permanent ? " 🔒" : "";
                        logger.plain(pc.dim("─".repeat(50)));
                        logger.plain(`${conflict.explanation}${lockIcon}`);
                        logger.plain(pc.dim(`Past decision (${date}, ${d.recommendedBy}, confidence ${d.confidence.toFixed(2)}):`));
                        logger.plain(pc.dim(`"${d.decision}"`));
                        logger.plain(pc.dim(`Reasoning: "${d.reasoning.slice(0, 100)}${d.reasoning.length > 100 ? "..." : ""}"`));
                    }
                    logger.plain(pc.dim("─".repeat(50)));

                    const options: Array<{ label: string; value: string }> = [];
                    if (!hasPermanent) {
                        options.push({ label: "Proceed anyway — I know what I'm doing", value: "proceed" });
                    }
                    options.push(
                        { label: "Reconsider the past decision(s) — they no longer apply", value: "reconsider" },
                        { label: "Adjust my goal — let me rephrase it", value: "adjust_goal" },
                        { label: "Abort — I need to think about this", value: "abort" },
                    );

                    const choice = await select({
                        message: "How would you like to proceed?",
                        options,
                    });

                    if (clackIsCancel(choice) || choice === "abort") {
                        cancel("Work session cancelled due to drift conflict.");
                        process.exit(0);
                    }

                    if (choice === "reconsider") {
                        try {
                            const { DecisionStore } = await import("./journal/store.js");
                            const { GlobalMemoryManager } = await import("./memory/global/store.js");
                            const vmRecon = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
                            await vmRecon.init();
                            const embedderRecon = vmRecon.getEmbedder();
                            if (embedderRecon) {
                                const gmRecon = new GlobalMemoryManager();
                                await gmRecon.init(embedderRecon);
                                const dbRecon = gmRecon.getDb();
                                if (dbRecon) {
                                    const reconStore = new DecisionStore();
                                    await reconStore.init(dbRecon);
                                    for (const c of currentDriftResult.conflicts) {
                                        await reconStore.markReconsidered(c.decision.id);
                                    }
                                    logger.success(`Reconsidered ${currentDriftResult.conflicts.length} past decision(s).`);
                                }
                            }
                        } catch {
                            // Non-critical
                        }
                        break;
                    }

                    if (choice === "adjust_goal") {
                        driftRetries++;
                        if (driftRetries >= MAX_DRIFT_RETRIES) {
                            logger.warn("Max goal adjustment retries reached. Proceeding with current goal.");
                            break;
                        }
                        const newGoalInput = await clackText({
                            message: "Enter adjusted goal:",
                            placeholder: goalToCheck,
                        });
                        if (clackIsCancel(newGoalInput) || !newGoalInput) {
                            cancel("Work session cancelled.");
                            process.exit(0);
                        }
                        goalToCheck = String(newGoalInput).trim();
                        effectiveGoal = goalToCheck;

                        // Re-run drift detection with new goal
                        try {
                            const { detectDrift } = await import("./drift/detector.js");
                            const { DecisionStore } = await import("./journal/store.js");
                            const { GlobalMemoryManager } = await import("./memory/global/store.js");
                            const vmRe = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
                            await vmRe.init();
                            const embedderRe = vmRe.getEmbedder();
                            let reDecisions: import("./journal/types.js").Decision[] = [];
                            if (embedderRe) {
                                const gmRe = new GlobalMemoryManager();
                                await gmRe.init(embedderRe);
                                const dbRe = gmRe.getDb();
                                if (dbRe) {
                                    const dStoreRe = new DecisionStore();
                                    await dStoreRe.init(dbRe);
                                    reDecisions = await dStoreRe.getAll();
                                }
                            }
                            currentDriftResult = detectDrift(goalToCheck, reDecisions);
                        } catch {
                            break;
                        }
                        continue;
                    }

                    // choice === "proceed"
                    break;
                }
            }

            // Handle clarity issues only
            if (hasClarityIssues && clarityResult) {
                try {
                    const { generateQuestions } = await import("./clarity/questioner.js");
                    const { rewriteGoal } = await import("./clarity/rewriter.js");
                    const { suggestSplits } = await import("./clarity/breadth-analyzer.js");
                    const { select, text: clackText, isCancel: clackIsCancel } = await import("@clack/prompts");

                    const cIcon = clarityResult.score < 0.5 ? "🚨" : "🔍";
                    const cLabel = clarityResult.score < 0.5
                        ? "This goal needs clarification before the team can plan"
                        : "This goal could be clearer";

                    logger.plain(`\n${cIcon} ${pc.yellow("Goal clarity check...")}`);
                    logger.plain(pc.dim("┌─────────────────────────────────────────────────────────────┐"));
                    logger.plain(`│ ${cLabel}`);
                    logger.plain(pc.dim("├─────────────────────────────────────────────────────────────┤"));
                    for (const issue of clarityResult.issues) {
                        const badge = issue.severity === "blocking"
                            ? pc.red("[blocking]")
                            : pc.yellow("[advisory]");
                        logger.plain(`│ ${badge} ${issue.question}`);
                    }
                    logger.plain(pc.dim("└─────────────────────────────────────────────────────────────┘"));

                    if (clarityResult.suggestions.length > 0) {
                        logger.plain(pc.dim("Suggestions:"));
                        for (const s of clarityResult.suggestions) {
                            logger.plain(pc.dim(`  → ${s}`));
                        }
                    }

                    const hasTooWide = clarityResult.issues.some((i) => i.type === "too_broad");
                    const options: Array<{ label: string; value: string }> = [
                        { label: "Answer the questions — I'll clarify the goal", value: "clarify" },
                        { label: "Proceed anyway — I want the team to interpret it", value: "proceed" },
                        { label: "Rephrase my goal", value: "rephrase" },
                    ];
                    if (hasTooWide) {
                        options.push({ label: "Split into focused goals", value: "split" });
                    }

                    const choice = await select({ message: "How would you like to proceed?", options });

                    if (clackIsCancel(choice)) {
                        cancel("Work session cancelled.");
                        process.exit(0);
                    }

                    if (choice === "clarify") {
                        const questions = generateQuestions(clarityResult.issues);
                        const answers: Array<{ issue: (typeof questions)[0]["issue"]; answer: string }> = [];
                        for (const q of questions) {
                            const answer = await clackText({
                                message: q.question,
                                placeholder: q.placeholder,
                            });
                            if (clackIsCancel(answer)) {
                                cancel("Work session cancelled.");
                                process.exit(0);
                            }
                            answers.push({ issue: q.issue, answer: String(answer).trim() });
                        }
                        const clarified = rewriteGoal(effectiveGoal, answers);
                        logger.plain(pc.bold("Clarified goal:"));
                        logger.plain(pc.green(`"${clarified}"`));
                        effectiveGoal = clarified;
                        logger.plain(pc.green("✓ Goal is clear. Proceeding to decomposition."));
                    } else if (choice === "rephrase") {
                        const newGoal = await clackText({
                            message: "Enter your rephrased goal:",
                            placeholder: effectiveGoal,
                        });
                        if (clackIsCancel(newGoal) || !newGoal) {
                            cancel("Work session cancelled.");
                            process.exit(0);
                        }
                        effectiveGoal = String(newGoal).trim();
                        logger.plain(pc.green("✓ Goal updated. Proceeding to decomposition."));
                    } else if (choice === "split") {
                        const breadthIssue = clarityResult.issues.find((i) => i.type === "too_broad");
                        const domains = breadthIssue
                            ? breadthIssue.question.match(/domains?:\s*(.+?)\./)?.[1]?.split(", ") ?? []
                            : [];
                        const splits = suggestSplits(effectiveGoal, domains);
                        if (splits.length > 0) {
                            logger.plain(pc.bold("Suggested sub-goals:"));
                            const splitOptions = splits.map((s, i) => ({
                                label: s,
                                value: String(i),
                            }));
                            const picked = await select({
                                message: "Pick one to run now (others saved to backlog):",
                                options: splitOptions,
                            });
                            if (!clackIsCancel(picked)) {
                                const idx = Number(picked);
                                effectiveGoal = splits[idx] ?? effectiveGoal;
                                logger.plain(pc.green(`✓ Running: "${effectiveGoal}"`));
                            }
                        }
                    }
                    // choice === "proceed" → continue with original goal
                } catch {
                    logger.warn("Clarity check interaction failed — proceeding without it.");
                }
            }

            // Neither has issues
            if (!hasDriftIssues && !hasClarityIssues) {
                if (clarityResult?.isClear) {
                    logger.plain(pc.green("✓ Goal is clear."));
                }
            }
        }
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
    try {
        DEBUG_LOG_PATH = await rotateAndCreateSessionLog({
            logDir: path.join(os.homedir(), ".teamclaw", "logs"),
            prefix: "work-session",
            maxFiles: 10,
        });
    } catch {
        DEBUG_LOG_PATH = path.join(CONFIG.workspaceDir, "teamclaw-debug.log");
    }
    try {
        WORK_HISTORY_LOG_PATH = await rotateAndCreateSessionLog({
            logDir: path.join(os.homedir(), ".teamclaw", "logs"),
            prefix: "work-history",
            maxFiles: 20,
        });
    } catch {
        WORK_HISTORY_LOG_PATH = path.join(CONFIG.workspaceDir, "work_history.log");
    }

    const memoryConfig = await loadTeamConfig();
    const selectedMemoryBackend: MemoryBackend =
        memoryConfig?.memory_backend ?? CONFIG.memoryBackend;
    if (selectedMemoryBackend === "local_json") {
        log("info", "   Using local JSON memory backend (fast startup, no Docker).");
    } else {
        log("info", "   Using embedded LanceDB memory backend (fast startup, no Docker).");
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
        log("error", result.message);
        process.exit(1);
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

    // Display streaming LLM output in terminal
    const streamingEnabled = setupConfig.streaming?.enabled !== false && !parsed.noStream;
    const streamChunkListener = streamingEnabled && canRenderSpinner
        ? (data: { botId: string; chunk: string }) => {
            process.stdout.write(pc.dim(data.chunk));
        }
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
                log("warn", "--async requires webhookApproval.url and webhookApproval.secret in ~/.teamclaw/config.json");
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
                if (canRenderSpinner && runId === 1) {
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
                let elapsedSeconds = 0;
                sPlan.start(randomPhrase("plan"));

                const heartbeatInterval = setInterval(() => {
                    const newElapsed = Math.floor((Date.now() - startTime) / 5000) * 5;
                    if (newElapsed > elapsedSeconds) {
                        elapsedSeconds = newElapsed;
                        sPlan.message(`🧠 Coordinator is decomposing the goal (${elapsedSeconds}s)`);
                    }
                }, 5000);

                try {
                    let bridge: { sendNodeEvent: (n: string, s: Record<string, unknown>) => void; sendCycleStart: (c: number, m: number) => void; sendSessionComplete: () => void; sendError: (m: string) => void } | null = null;
                    try {
                        const { getDashboardBridge } = await import("./core/dashboard-bridge.js");
                        bridge = getDashboardBridge();
                    } catch {
                        // Bridge not initialized
                    }

                    let lastCycle = 0;
                    let spinnerStopped = false;

                    const stopSpinner = (msg: string) => {
                        if (!spinnerStopped) {
                            clearInterval(heartbeatInterval);
                            sPlan.stop(msg);
                            spinnerStopped = true;
                        }
                    };

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
                                const elapsedNow = Math.floor((Date.now() - startTime) / 1000);
                                sPlan.message(`🧠 ${nodeName} (${elapsedNow}s)`);
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
                    clearInterval(heartbeatInterval);
                    const message =
                        error instanceof Error ? error.message : String(error);

                    if (sessionAbort.signal.aborted || message === "Aborted") {
                        sPlan.stop("Work session cancelled by user.");
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
                        process.exit(1);
                    }

                    sPlan.stop(
                        `✗ Coordinator failed to decompose goal: ${message}`,
                    );
                    const isFatal =
                        /HTTP [45]\d\d|ECONNREFUSED|ENOTFOUND|404|Not Found|fetch failed/i.test(message);
                    if (isFatal) {
                        const friendly = formatError("CONNECTION_FAILED", "your provider", message.split("\n")[0]);
                        cancel(friendly);
                        clearSessionConfig();
                        process.exit(1);
                    }
                    throw error;
                }

                clearInterval(heartbeatInterval);

                const taskQueue = (finalState.task_queue ?? []) as Record<string, unknown>[];
                sPlan.stop(`✅ Goal decomposed into ${taskQueue.length} tasks.`);

                const executionMessages = (finalState.messages ?? []) as string[];
                for (const msg of executionMessages) {
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
                log("info", `Run ${runId} completed`);
                log("info", `   Cycles: ${(finalState as Record<string, unknown>).cycle_count}`);
                log("info", `   Tasks: ${totalDone} completed, ${totalFailed} failed`);
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
                log("error", `Fatal provider error: ${errMsg}`);
                log("error", "Run `teamclaw setup` to reconfigure providers or `teamclaw check` to diagnose.");
                clearSessionConfig();
                process.exit(1);
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
    if (streamChunkListener) workerEvents.off("stream-chunk", streamChunkListener);
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
    // across work sessions. Stop it explicitly with `teamclaw web stop`.

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
        outro("Done! Run teamclaw work whenever you're ready.");
    }
}
