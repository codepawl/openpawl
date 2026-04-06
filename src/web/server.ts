/**
 * Fastify server for OpenPawl web UI.
 * Serves static HTML and streams workflow events via SSE.
 * Client→server commands use REST endpoints.
 */

import Fastify from "fastify";
import FastifyCors from "@fastify/cors";
import FastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { createTeamOrchestration } from "../core/simulation.js";
import { buildTeamFromRoster, buildTeamFromTemplate } from "../core/team-templates.js";
import type { ApprovalResponse } from "../agents/approval.js";
import {
  setSessionConfig,
  clearSessionConfig,
  updateSessionCreativity,
} from "../core/config.js";
import { loadTeamConfig, clearTeamConfigCache } from "../core/team-config.js";
import { writeFile, mkdir } from "node:fs/promises";
import { VectorMemory } from "../core/knowledge-base.js";
import { PostMortemAnalyst } from "../agents/analyst.js";
import { CONFIG } from "../core/config.js";
import type { GraphState } from "../core/graph-state.js";
import {
  fireTaskCompleteWebhook,
  fireCycleEndWebhook,
} from "./webhooks.js";
import { getGlobalProviderManager } from "../providers/provider-factory.js";
import { validateStartup } from "../core/startup-validation.js";
import { llmHealthCheck } from "../core/llm-client.js";
import { getTeamTemplate } from "../core/team-templates.js";
import { logger } from "../core/logger.js";
import { ensureWorkspaceDir } from "../core/workspace-fs.js";
import { initTerminalBroadcast } from "../core/terminal-broadcast.js";
import { log, note, spinner } from "@clack/prompts";
import { randomPhrase } from "../utils/spinner-phrases.js";
import { readGlobalConfigWithDefaults } from "../core/global-config.js";
import { findAvailablePort } from "../core/port.js";
import { proxyPlugin } from "../proxy/plugin.js";
import { humanResponseEmitter } from "../core/human-response-events.js";
import { getDefaultGoal } from "../core/configManager.js";
import { ProfileStore } from "../agents/profiles/store.js";
import { coordinatorEvents, type CoordinatorStep } from "../core/coordinator-events.js";
import { workerEvents } from "../core/worker-events.js";
import { llmEvents, type LlmLogEntry } from "../core/llm-events.js";
import { startGatewayLogTailer } from "../core/gateway-log-tailer.js";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  currentSessionState,
  broadcast,
  updateSessionState,
  addSseClient,
  removeSseClient,
  sessionControl,
  resetSessionControl,
  approvalProvider,
  partialApprovalProvider,
  getApprovalResolve,
  setApprovalResolve,
  getPreviewResolve,
  setPreviewResolve,
  getTaskApprovalResolver,
  clearTaskApprovalResolver,
  getWebhookTokenManager,
  initWebhookTokenManager,
  cliCycles,
  cliGenerations,
  cliCreativity,
  cliSessionMode,
  cliSessionDuration,
  getFullConfig,
  applyConfigOverrides,
  SERVER_START_TS,
} from "./session-state.js";
import { createWebhookApprovalProvider } from "../webhook/provider.js";
import type { WebhookCallbackBody } from "../webhook/types.js";

import { parseNodeEvent } from "./node-events.js";
import {
  getModelConfig,
  listAvailableModels,
  resolveAlias,
  isModelAllowed,
} from "../core/model-config.js";
import {
  persistDefaultModel,
  persistAgentModel,
} from "../core/model-operations.js";
import { THREAD_REGISTRY, startTimeoutChecker } from "./timeout-checker.js";
import { SuccessPatternStore } from "../memory/success/store.js";
import { LearningCurveStore } from "../memory/success/learning-curve.js";
import { PatternQualityStore } from "../memory/success/quality.js";
import { GlobalMemoryManager } from "../memory/global/store.js";
import { PromotionEngine } from "../memory/global/promoter.js";
import { computeHealth } from "../memory/global/health.js";
import { exportGlobalMemory, importGlobalMemory } from "../memory/global/portability.js";
import type { MemoryExport } from "../memory/global/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";

function resolveClientDir(): string | null {
  const candidates = [
    path.join(__dirname, "client"),                    // dist/client (built output)
    path.join(__dirname, "..", "client"),
    path.join(__dirname, "..", "dist", "client"),
    path.join(__dirname, "client", "dist"),
  ];
  for (const p of candidates) {
    if (existsSync(path.join(p, "index.html"))) {
      return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestration state (module-level — only one session at a time)
// ---------------------------------------------------------------------------
let runThreadId: string | null = null;
let currentOrch: ReturnType<typeof createTeamOrchestration> | null = null;

export async function runWeb(args: string[]): Promise<void> {
  const canRenderSpinner = Boolean(process.stdout.isTTY && process.stderr.isTTY);
  const s = canRenderSpinner ? spinner() : null;
  if (s) {
    s.start(randomPhrase("boot"));
  }

  initTerminalBroadcast();
  startTimeoutChecker();

  coordinatorEvents.on("progress", (data: CoordinatorStep) => {
    broadcast({
      type: "node_event",
      node: "coordinator",
      data: { message: data.detail, step: data.step },
      state: {
        cycle: currentSessionState.cycle,
        task_queue: currentSessionState.taskQueue,
        bot_stats: currentSessionState.botStats,
      },
      timestamp: new Date().toTimeString().slice(0, 8),
    });
  });

  workerEvents.on("progress", (data: { taskQueue: Record<string, unknown>[] }) => {
    broadcast({ type: "task_queue_updated", task_queue: data.taskQueue });
    updateSessionState({ taskQueue: data.taskQueue });
  });

  llmEvents.on("log", (entry: LlmLogEntry) => {
    broadcast({ type: "llm_log", entry });
  });

  startGatewayLogTailer();

  const result = await validateStartup({ templateId: "game_dev" });
  if (!result.ok) {
    logger.warn(`Gateway health check failed: ${result.message}`);
    if (s) {
      s.message("Gateway unavailable — dashboard will start without it");
    }
    updateSessionState({ gatewayAvailable: false });
  } else {
    updateSessionState({ gatewayAvailable: true });
  }

  await ensureWorkspaceDir(CONFIG.workspaceDir);
  if (s) {
    s.message(randomPhrase("boot"));
  }

  const globalCfg = readGlobalConfigWithDefaults();
  let requestedPort = globalCfg.dashboardPort;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) {
      requestedPort = parseInt(args[i + 1], 10) || globalCfg.dashboardPort;
      i++;
    }
  }
  const port = await findAvailablePort(requestedPort);
  if (canRenderSpinner && port !== requestedPort) {
    log.info(`Port ${requestedPort} is in use, trying ${port}...`);
  }

  const fastify = Fastify({ logger: false });
  if (s) {
    s.message("Configuring HTTP server and routes...");
  }
  await fastify.register(FastifyCors, {
    origin: isProduction ? false : "http://localhost:5173",
  });

  const clientDir = resolveClientDir();
  if (clientDir) {
    await fastify.register(FastifyStatic, {
      root: clientDir,
      index: ["index.html"],
      wildcard: false,
    });
  } else {
    logger.warn(
      "Web client build not found. Run `bun run client:build` to serve the dashboard UI.",
    );
  }

  // ---------------------------------------------------------------------------
  // Proxy plugin — local SSE proxy for LLM requests
  // ---------------------------------------------------------------------------
  const proxyCfg = globalCfg.proxy ?? {};
  await fastify.register(proxyPlugin, {
    basePath: proxyCfg.path ?? "/proxy",
    logLevel: proxyCfg.logLevel ?? "info",
  });

  // ---------------------------------------------------------------------------
  // REST endpoints
  // ---------------------------------------------------------------------------

  // Simple health check for dashboard persistence detection
  fastify.get("/health", async () => ({ status: "ok" }));

  // Re-check LLM gateway availability (called by dashboard to clear the banner)
  fastify.post("/api/gateway/check", async () => {
    const ok = await llmHealthCheck();
    updateSessionState({ gatewayAvailable: ok });
    if (ok) broadcast({ type: "state_sync", state: { gatewayAvailable: true } });
    return { available: ok };
  });

  fastify.get("/api/config", async () => {
    const runtime = getFullConfig();
    const teamConfig = await loadTeamConfig();
    return {
      ...runtime,
      saved_template: teamConfig?.template,
      saved_roster: teamConfig?.roster,
      saved_goal: teamConfig?.goal,
      saved_worker_url: teamConfig?.worker_url,
    };
  });

  fastify.get("/api/lessons", async () => {
    const teamConfig = await loadTeamConfig();
    const vectorMemory = new VectorMemory(
      CONFIG.vectorStorePath,
      teamConfig?.memory_backend ?? CONFIG.memoryBackend
    );
    await vectorMemory.init();
    const lessons = await vectorMemory.getCumulativeLessons();
    return { lessons };
  });

  // --- Personality endpoints ---

  fastify.get("/api/personality/profiles", async () => {
    const { PERSONALITY_PROFILES } = await import("../personality/profiles.js");
    return { profiles: PERSONALITY_PROFILES };
  });

  fastify.get("/api/personality/events", async () => {
    try {
      const lancedb = await import("@lancedb/lancedb");
      const { PersonalityEventStore } = await import("../personality/memory.js");
      const dbPath = path.join(os.homedir(), ".openpawl", "memory", "global.db");
      const db = await lancedb.connect(dbPath);
      const store = new PersonalityEventStore();
      await store.init(db);
      const events = await store.getRecent(30);
      return { events };
    } catch {
      return { events: [] };
    }
  });

  fastify.get("/api/personality/config", async () => {
    return {
      config: {
        enabled: CONFIG.personalityEnabled,
        pushbackEnabled: CONFIG.personalityPushbackEnabled,
        coordinatorIntervention: CONFIG.personalityCoordinatorIntervention,
        agentOverrides: CONFIG.personalityAgentOverrides,
      },
    };
  });

  fastify.post("/api/config", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const template = (body.template as string)?.trim() || "game_dev";
    const roster = Array.isArray(body.roster) ? (body.roster as unknown[]) : undefined;
    const goal = (body.goal as string)?.trim() || "";
    const workerUrl = (body.worker_url as string)?.trim() || "";
    const workers = body.workers as Record<string, string> | undefined;
    const configPath = path.join(process.cwd(), "openpawl.config.json");
    const config: Record<string, unknown> = roster ? { roster, goal } : { template, goal };
    if (workerUrl) config.worker_url = workerUrl;
    if (workers && Object.keys(workers).length > 0) config.workers = workers;
    const creativityVal = typeof body.creativity === "number" ? body.creativity : undefined;
    const maxCyclesVal = typeof body.max_cycles === "number" ? body.max_cycles : undefined;
    const maxGensVal = typeof body.max_generations === "number" ? body.max_generations : undefined;
    const sessionModeVal = body.session_mode === "runs" || body.session_mode === "time" ? body.session_mode : undefined;
    const sessionDurationVal = typeof body.session_duration === "number" ? body.session_duration : undefined;
    if (creativityVal !== undefined) config.creativity = Math.max(0, Math.min(1, creativityVal));
    if (maxCyclesVal !== undefined) config.max_cycles = Math.max(1, Math.floor(maxCyclesVal));
    if (maxGensVal !== undefined) config.max_generations = Math.max(1, Math.floor(maxGensVal));
    if (sessionModeVal !== undefined) config.session_mode = sessionModeVal;
    if (sessionDurationVal !== undefined) config.session_duration = Math.max(1, Math.floor(sessionDurationVal));
    try {
      await writeFile(configPath, JSON.stringify(config, null, 2));
      clearTeamConfigCache();
      applyConfigOverrides({ creativity: creativityVal, max_cycles: maxCyclesVal, max_generations: maxGensVal, session_mode: sessionModeVal, session_duration: sessionDurationVal });
      if (creativityVal !== undefined) updateSessionCreativity(creativityVal);
      broadcast({ type: "config_updated", config: getFullConfig() });
      return { ok: true, path: configPath };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: String(err) });
    }
  });

  fastify.get("/api/models", async () => {
    const available = await listAvailableModels();
    const config = getModelConfig();
    return {
      available,
      default_model: config.defaultModel,
      agent_models: config.agentModels,
      fallback_chain: config.fallbackChain,
      aliases: config.aliases,
      allowlist: config.allowlist,
    };
  });

  // ---------------------------------------------------------------------------
  // SSE endpoint — replaces WebSocket for server→client streaming
  // ---------------------------------------------------------------------------
  fastify.get("/api/events", async (req, reply) => {
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send init payload (config + state sync)
    const teamConfig = await loadTeamConfig();
    const initConfig = {
      ...getFullConfig(),
      saved_template: teamConfig?.template,
      saved_goal: teamConfig?.goal,
      saved_worker_url: teamConfig?.worker_url,
      generation: currentSessionState.generation,
      is_running: currentSessionState.isRunning,
    };
    const initPayload = JSON.stringify({ type: "init", config: initConfig, server_start_ts: SERVER_START_TS });
    raw.write(`data: ${initPayload}\n\n`);

    // Send state_sync
    const stateSyncPayload = JSON.stringify({
      type: "state_sync",
      state: {
        activeNode: currentSessionState.activeNode,
        cycle: currentSessionState.cycle,
        taskQueue: currentSessionState.taskQueue,
        botStats: currentSessionState.botStats,
        isRunning: currentSessionState.isRunning,
        generation: currentSessionState.generation,
        generationProgress: currentSessionState.generationProgress,
        cycleProgress: currentSessionState.cycleProgress,
        pendingApproval: currentSessionState.pendingApproval,
        gatewayAvailable: currentSessionState.gatewayAvailable,
      },
    });
    raw.write(`data: ${stateSyncPayload}\n\n`);

    // Replay missed events if Last-Event-ID provided
    const lastIdHeader = req.headers["last-event-id"];
    const lastEventId = lastIdHeader ? parseInt(String(lastIdHeader), 10) : 0;

    const clientId = randomUUID();
    const client = { id: clientId, res: raw };
    addSseClient(client, lastEventId || undefined);

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
      try {
        raw.write(": keepalive\n\n");
      } catch {
        clearInterval(keepAlive);
      }
    }, 30_000);

    req.raw.on("close", () => {
      clearInterval(keepAlive);
      removeSseClient(client);
    });

    // Prevent Fastify from closing the response
    reply.hijack();
  });

  // ---------------------------------------------------------------------------
  // REST command endpoints — replace WS message commands
  // ---------------------------------------------------------------------------

  fastify.post("/api/session/start", async (req, reply) => {
    const msg = (req.body ?? {}) as Record<string, unknown>;
    const startConfig = msg.config as Record<string, unknown> | undefined;
    if (startConfig) applyConfigOverrides(startConfig);
    const teamConfig = await loadTeamConfig();
    setSessionConfig({
      creativity: cliCreativity,
      gateway_url: teamConfig?.gateway_url,
      team_model: teamConfig?.team_model,
    });
    const userGoal =
      (msg.user_goal as string) ??
      getDefaultGoal();
    const teamTemplate =
      (msg.team_template as string) ?? teamConfig?.template ?? "game_dev";
    broadcast({ type: "config_updated", config: getFullConfig() });

    if (getTeamTemplate(teamTemplate) === null) {
      return reply.status(400).send({
        type: "error",
        message: "Invalid template. Use game_dev, startup, or content.",
      });
    }

    // Reset session control for new session
    resetSessionControl();
    sessionControl.paused = false;

    // Re-check gateway so the banner clears when a provider was added after boot
    const gwOk = await llmHealthCheck();
    updateSessionState({ gatewayAvailable: gwOk });
    if (gwOk) broadcast({ type: "state_sync", state: { gatewayAvailable: true } });

    // Fire orchestration in background
    (async () => {
      const pm = getGlobalProviderManager();
      if (pm.getProviders().length === 0) {
        broadcast({
          type: "provision_error",
          error: "No LLM providers configured. Run `openpawl setup` or set an API key env var.",
        });
        return;
      }

      const vectorMemory = new VectorMemory(
        CONFIG.vectorStorePath,
        teamConfig?.memory_backend ?? CONFIG.memoryBackend
      );
      await vectorMemory.init();
      const analyst = new PostMortemAnalyst(vectorMemory);

      const effectiveMaxGenerations = cliSessionMode === "time" ? 999 : cliGenerations;
      const effectiveTimeoutMinutes = cliSessionMode === "time" ? cliSessionDuration : 0;
      const sessionStartMs = Date.now();

      for (let genId = 1; genId <= effectiveMaxGenerations; genId++) {
        if (cliSessionMode === "time" && effectiveTimeoutMinutes > 0) {
          const elapsed = Date.now() - sessionStartMs;
          if (elapsed >= effectiveTimeoutMinutes * 60_000) break;
        }
        if (sessionControl.cancelled) break;

        const priorLessons = await vectorMemory.getCumulativeLessons();
        broadcast({
          type: "generation_start",
          generation: genId,
          max_generations: effectiveMaxGenerations,
          lessons_count: priorLessons.length,
          session_mode: cliSessionMode,
          session_duration: cliSessionMode === "time" ? cliSessionDuration : undefined,
        });
        updateSessionState({
          generation: genId, isRunning: true, activeNode: null, cycle: 0,
          generationProgress: { generation: genId, maxGenerations: effectiveMaxGenerations, lessonsCount: priorLessons.length, startedAt: Date.now() },
          cycleProgress: null,
        });

        const team =
          teamConfig?.roster && teamConfig.roster.length > 0
            ? buildTeamFromRoster(teamConfig.roster)
            : buildTeamFromTemplate(teamTemplate);
        runThreadId = randomUUID();

        // Wire webhook approval provider if configured
        let effectivePartialProvider = partialApprovalProvider;
        if (CONFIG.webhookApprovalUrl && CONFIG.webhookApprovalSecret) {
          initWebhookTokenManager(CONFIG.webhookApprovalSecret);
          const webhookCfg = {
            url: CONFIG.webhookApprovalUrl,
            secret: CONFIG.webhookApprovalSecret,
            provider: CONFIG.webhookApprovalProvider as "slack" | "generic",
            timeoutSeconds: CONFIG.webhookApprovalTimeoutSeconds,
            retryAttempts: CONFIG.webhookApprovalRetryAttempts,
            callbackBaseUrl: `http://localhost:${port}`,
            sessionId: runThreadId,
          };
          effectivePartialProvider = createWebhookApprovalProvider(webhookCfg, partialApprovalProvider);
        }

        const orch = createTeamOrchestration({
          team,
          approvalProvider,
          partialApprovalProvider: effectivePartialProvider,
        });
        orch.configureSession({
          maxRuns: cliCycles,
          timeoutMinutes: effectiveTimeoutMinutes,
        });
        currentOrch = orch;
        if (runThreadId) {
          THREAD_REGISTRY.set(runThreadId, { orch });
        }
        const initialState = orch.getInitialState({
          userGoal,
          ancestralLessons: priorLessons,
        });
        let lastCycle = 0;
        let finalState: GraphState = initialState;

        try {
          for await (const chunk of await orch.graph.stream(initialState, {
            streamMode: "values",
            configurable: { thread_id: runThreadId },
          })) {
            if (sessionControl.cancelled) break;
            while (sessionControl.paused && !sessionControl.cancelled) {
              await new Promise((r) => setTimeout(r, 100));
            }
            const nodeState = chunk as Record<string, unknown>;
            const nodeName = (nodeState.__node__ as string) ?? "unknown";
            if (!nodeName || nodeName === "unknown") continue;
            finalState = nodeState as unknown as GraphState;

            const cycle = (nodeState.cycle_count as number) ?? 0;
            if (cycle > lastCycle) {
              lastCycle = cycle;
              broadcast({
                type: "cycle_start",
                cycle,
                max_cycles: cliCycles,
              });
              updateSessionState({ cycleProgress: { cycle, maxCycles: cliCycles, startedAt: Date.now() } });
            }

            const parsed = parseNodeEvent(nodeName, nodeState);
            if (nodeName === "worker_execute") {
              (parsed.data as Record<string, unknown>).bot_stats =
                nodeState.bot_stats ?? {};
              const d = parsed.data as Record<string, unknown>;
              fireTaskCompleteWebhook({
                task_id: (d.task_id as string) ?? "",
                success: (d.success as boolean) ?? false,
                output: (d.output as string) ?? undefined,
                quality_score: (d.quality_score as number) ?? undefined,
                assigned_to: (d.assigned_to as string) ?? undefined,
                description: (d.description as string) ?? undefined,
                bot_id: (d.assigned_to as string) ?? undefined,
              }).catch(() => {});
            }
            if (nodeName === "increment_cycle") {
              const cycle = (nodeState.cycle_count as number) ?? 0;
              const botStats = (nodeState.bot_stats ?? {}) as Record<string, Record<string, unknown>>;
              const tc = Object.values(botStats).reduce(
                (s, x) => s + ((x?.tasks_completed as number) ?? 0),
                0
              );
              const tf = Object.values(botStats).reduce(
                (s, x) => s + ((x?.tasks_failed as number) ?? 0),
                0
              );
              fireCycleEndWebhook({
                cycle,
                max_cycles: cliCycles,
                tasks_completed: tc,
                tasks_failed: tf,
              }).catch(() => {});
            }
            broadcast({ type: "node_event", ...parsed });

            updateSessionState({
              activeNode: nodeName,
              taskQueue: nodeState.task_queue as Record<string, unknown>[] ?? [],
              botStats: nodeState.bot_stats as Record<string, Record<string, unknown>> ?? {},
              cycle: (nodeState.cycle_count as number) ?? 0,
              isRunning: true,
            });

            await new Promise((r) =>
              setTimeout(r, 300 / sessionControl.speedFactor)
            );
          }
        } catch (err) {
          broadcast({ type: "error", message: String(err) });
          break;
        }

        if (sessionControl.cancelled) {
          broadcast({ type: "session_cancelled" });
          break;
        }

        const botStats =
          (finalState as Record<string, unknown>).bot_stats as Record<
            string,
            Record<string, unknown>
          > | null;
        const totalDone = botStats
          ? Object.values(botStats).reduce(
              (s, x) => s + ((x?.tasks_completed as number) ?? 0),
              0
            )
          : 0;
        const totalFailed = botStats
          ? Object.values(botStats).reduce(
              (s, x) => s + ((x?.tasks_failed as number) ?? 0),
              0
            )
          : 0;
        const failed =
          totalDone + totalFailed > 0 &&
          (totalFailed >= totalDone || totalDone === 0);
        const outcome = failed ? "failure" : "success";

        if (failed) {
          const stateWithCause = {
            ...finalState,
            death_reason: `Tasks: ${totalFailed} failed, ${totalDone} completed`,
            generation_id: genId,
          };
          await analyst.analyzeFailure(stateWithCause);
        }

        const fs = {
          cycles_survived: (finalState as Record<string, unknown>).cycle_count ?? 0,
          tasks_completed: totalDone,
          tasks_failed: totalFailed,
        };
        broadcast({
          type: "generation_end",
          generation: genId,
          outcome,
          final_state: fs,
          gen_summary: { outcome, final_state: fs },
        });
        updateSessionState({ generationProgress: null, cycleProgress: null });

        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!sessionControl.cancelled) {
        broadcast({ type: "session_complete" });
      }
      if (runThreadId) {
        THREAD_REGISTRY.delete(runThreadId);
      }
      runThreadId = null;
      currentOrch = null;
      updateSessionState({ isRunning: false, activeNode: null, generationProgress: null, cycleProgress: null, pendingApproval: null });
      clearSessionConfig();
    })();

    return { ok: true };
  });

  fastify.post("/api/session/pause", async () => {
    sessionControl.paused = true;
    return { ok: true };
  });

  fastify.post("/api/session/resume", async () => {
    sessionControl.paused = false;
    return { ok: true };
  });

  fastify.post("/api/session/cancel", async () => {
    sessionControl.cancelled = true;
    sessionControl.paused = false;
    return { ok: true };
  });

  fastify.post("/api/session/speed", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const v = Number(body.value ?? 1);
    sessionControl.speedFactor = Math.max(0.25, Math.min(5, v));
    return { ok: true, speedFactor: sessionControl.speedFactor };
  });

  fastify.post("/api/session/config", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const values = (body.values as Record<string, unknown>) ?? body;
    applyConfigOverrides(values);
    if (typeof values.creativity === "number") {
      updateSessionCreativity(values.creativity as number);
    }
    broadcast({ type: "config_updated", config: getFullConfig() });
    return { ok: true };
  });

  fastify.post("/api/approval/respond", async (req) => {
    const msg = (req.body ?? {}) as Record<string, unknown>;
    const action = (msg.action as string) ?? "approved";
    const feedback = msg.feedback as string | undefined;
    const taskId = msg.task_id as string | undefined;

    humanResponseEmitter.emitResponse({
      action: action as "approved" | "edited" | "feedback",
      feedback,
      taskId,
    });

    const resolver = getApprovalResolve();
    if (resolver) {
      resolver({
        action: action as ApprovalResponse["action"],
        edited_task: msg.edited_task as { description: string } | undefined,
        feedback,
      });
      setApprovalResolve(null);
    }
    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // Per-task partial approval response (dashboard → partial_approval node)
  // -----------------------------------------------------------------------
  fastify.post("/api/approval/task-respond", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = body.task_id as string;
    const action = body.action as string;
    const feedback = body.feedback as string | undefined;

    if (action === "reject" && (!feedback || !feedback.trim())) {
      return reply.status(400).send({ type: "error", message: "Feedback required for rejection" });
    }

    const resolver = getTaskApprovalResolver(taskId);
    if (resolver) {
      resolver({ action: action as "approve" | "reject" | "escalate", feedback });
      clearTaskApprovalResolver(taskId);
      broadcast({ type: "partial_approval_resolved", task_id: taskId, action });
    }
    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // Webhook approval — inbound callback from external systems
  // -----------------------------------------------------------------------
  fastify.post("/webhook/approval", async (req, reply) => {
    const tokenManager = getWebhookTokenManager();
    if (!tokenManager) {
      return reply.status(404).send({ error: "Webhook approvals not configured" });
    }

    const body = (req.body ?? {}) as WebhookCallbackBody;
    if (!body.token) {
      return reply.status(400).send({ error: "Missing token" });
    }

    const payload = tokenManager.consume(body.token);
    if (!payload) {
      // Check if token is valid but expired or already consumed
      const verified = tokenManager.verify(body.token);
      if (!verified) {
        return reply.status(401).send({ error: "Invalid or expired token" });
      }
      // verify passed but consume failed → already consumed
      return reply.status(409).send({ error: "Token already consumed" });
    }

    if (runThreadId && payload.sessionId !== runThreadId) {
      return reply.status(404).send({ error: "Session no longer active" });
    }

    if (payload.action === "reject" && (!body.feedback || !body.feedback.trim())) {
      return reply.status(400).send({ error: "Feedback required for rejection" });
    }

    const resolver = getTaskApprovalResolver(payload.taskId);
    if (!resolver) {
      return reply.status(404).send({ error: "Task not pending approval" });
    }

    resolver({
      action: payload.action,
      feedback: body.feedback,
    });
    clearTaskApprovalResolver(payload.taskId);
    broadcast({ type: "partial_approval_resolved", task_id: payload.taskId, action: payload.action });

    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // Webhook approval — browser redirect page for Slack URL buttons
  // -----------------------------------------------------------------------
  fastify.get("/webhook/approval/respond", async (req, reply) => {
    const query = req.query as Record<string, string>;
    const token = query.token ?? "";
    const callbackUrl = `${req.protocol}://${req.hostname}/webhook/approval`;

    const html = `<!DOCTYPE html>
<html><head><title>OpenPawl Approval</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a1a;color:#e5e5e5}
.card{background:#262626;border-radius:12px;padding:2rem;text-align:center;max-width:400px}
.btn{display:inline-block;padding:0.75rem 1.5rem;border-radius:8px;border:none;font-size:1rem;cursor:pointer;margin:0.5rem}
.approve{background:#22c55e;color:#fff}.reject{background:#ef4444;color:#fff}.escalate{background:#f59e0b;color:#000}
#result{display:none}.feedback{display:none;margin-top:1rem}
textarea{width:100%;min-height:60px;border-radius:8px;border:1px solid #444;background:#333;color:#e5e5e5;padding:0.5rem;box-sizing:border-box}
</style></head><body>
<div class="card" id="form">
<h2>OpenPawl Approval</h2>
<p>Choose an action:</p>
<button class="btn approve" onclick="submit('approve')">Approve</button>
<button class="btn reject" onclick="showFeedback()">Reject</button>
<button class="btn escalate" onclick="submit('escalate')">Escalate</button>
<div class="feedback" id="fb"><textarea id="feedback" placeholder="Feedback (required for reject)..."></textarea>
<button class="btn reject" onclick="submitReject()">Submit Rejection</button></div>
</div>
<div class="card" id="result"><h2>Done!</h2><p id="msg"></p></div>
<script>
const token=${JSON.stringify(token)};
const url=${JSON.stringify(callbackUrl)};
function showFeedback(){document.getElementById('fb').style.display='block'}
async function submit(action){
  const body={token};
  try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();document.getElementById('form').style.display='none';
  document.getElementById('result').style.display='block';
  document.getElementById('msg').textContent=r.ok?'Approval submitted!':'Error: '+(d.error||r.status);
  }catch(e){alert('Failed: '+e)}}
async function submitReject(){const fb=document.getElementById('feedback').value.trim();
if(!fb){alert('Feedback required');return}
const body={token,feedback:fb};
try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const d=await r.json();document.getElementById('form').style.display='none';
document.getElementById('result').style.display='block';
document.getElementById('msg').textContent=r.ok?'Rejection submitted!':'Error: '+(d.error||r.status);
}catch(e){alert('Failed: '+e)}}
</script></body></html>`;

    return reply.type("text/html").send(html);
  });

  // -----------------------------------------------------------------------
  // Webhook approval — check pending approvals
  // -----------------------------------------------------------------------
  fastify.get("/webhook/approval/status", async () => {
    const tokenManager = getWebhookTokenManager();
    if (!tokenManager) {
      return { configured: false, pending: [] };
    }
    return { configured: true, sessionId: runThreadId };
  });

  // -----------------------------------------------------------------------
  // Preview response (dashboard → graph)
  // -----------------------------------------------------------------------
  fastify.post("/api/preview/respond", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = (body.action as string) ?? "approve";
    const resolver = getPreviewResolve();
    if (resolver) {
      resolver({
        action: action as "approve" | "edit" | "abort",
        editedTasks: body.editedTasks as import("../graph/preview/types.js").PreviewTask[] | undefined,
      });
      setPreviewResolve(null);
    }
    broadcast({ type: "preview_resolved", action });
    return { ok: true };
  });

  fastify.post("/api/tasks/:taskId", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates = (body.updates as Record<string, unknown>) ?? body;
    const status = updates.status as string | undefined;
    const priority = updates.priority as string | undefined;
    const assigned_to = updates.assigned_to as string | undefined;
    const urgency = updates.urgency as number | undefined;
    const importance = updates.importance as number | undefined;
    const timebox_minutes = updates.timebox_minutes as number | undefined;
    const allowedStatuses = [
      "pending",
      "in_progress",
      "completed",
      "failed",
      "backlog",
      "needs_approval",
      "TIMEOUT_WARNING",
    ];
    if (status && !allowedStatuses.includes(status)) {
      return reply.status(400).send({ type: "error", message: `Invalid status: ${status}` });
    }
    if (!runThreadId || !currentOrch) {
      return reply.status(400).send({ type: "error", message: "No active session" });
    }
    try {
      const config = { configurable: { thread_id: runThreadId } };
      const snapshot = await currentOrch.graph.getState(config);
      const values = (snapshot as { values?: Record<string, unknown> }).values ?? {};
      const taskQueue = (values.task_queue ?? []) as Record<string, unknown>[];
      const idx = taskQueue.findIndex((t) => (t.task_id as string) === taskId);
      if (idx < 0) {
        return reply.status(404).send({ type: "error", message: `Task not found: ${taskId}` });
      }
      const updatedTask = { ...taskQueue[idx] };
      if (status !== undefined) updatedTask.status = status;
      if (priority !== undefined) updatedTask.priority = priority;
      if (assigned_to !== undefined) updatedTask.assigned_to = assigned_to;
      if (urgency !== undefined) {
        const raw = Number(urgency);
        if (Number.isFinite(raw)) {
          updatedTask.urgency = Math.min(10, Math.max(1, raw));
        }
      }
      if (importance !== undefined) {
        const raw = Number(importance);
        if (Number.isFinite(raw)) {
          updatedTask.importance = Math.min(10, Math.max(1, raw));
        }
      }
      if (timebox_minutes !== undefined) {
        const raw = Number(timebox_minutes);
        if (Number.isFinite(raw) && raw >= 1) {
          updatedTask.timebox_minutes = raw;
        }
      }
      const updatedQueue = [...taskQueue];
      updatedQueue[idx] = updatedTask;
      await currentOrch.graph.updateState(config, { task_queue: updatedQueue });
      broadcast({ type: "task_queue_updated", task_queue: updatedQueue });
      updateSessionState({ taskQueue: updatedQueue });
      return { ok: true };
    } catch (err) {
      return reply.status(500).send({
        type: "error",
        message: String((err as Error).message ?? err),
      });
    }
  });

  fastify.post("/api/models/switch", async (req, reply) => {
    const msg = (req.body ?? {}) as Record<string, unknown>;
    const model = (msg.model as string)?.trim();
    const agent = (msg.agent as string)?.trim();
    if (!model) {
      return reply.status(400).send({ type: "error", message: "model_switch requires a model field" });
    }
    const resolved = resolveAlias(model);
    if (!isModelAllowed(resolved)) {
      return reply.status(400).send({ type: "error", message: `Model "${resolved}" is not in the allowlist` });
    }
    if (agent) {
      persistAgentModel(agent, resolved);
    } else {
      persistDefaultModel(resolved);
    }
    const updated = getModelConfig();
    broadcast({
      type: "model_updated",
      default_model: updated.defaultModel,
      agent_models: updated.agentModels,
      fallback_chain: updated.fallbackChain,
      aliases: updated.aliases,
      allowlist: updated.allowlist,
    });
    return { ok: true };
  });

  fastify.get("/api/models/state", async () => {
    const config = getModelConfig();
    return {
      type: "model_state",
      default_model: config.defaultModel,
      agent_models: config.agentModels,
      fallback_chain: config.fallbackChain,
      aliases: config.aliases,
      allowlist: config.allowlist,
      available_models: config.availableModels,
    };
  });

  fastify.post("/api/bridge/relay", async (req) => {
    const msg = (req.body ?? {}) as Record<string, unknown>;
    const event = msg.event as Record<string, unknown> | undefined;
    if (event && typeof event === "object") {
      broadcast(event);
      if (event.type === "node_event") {
        const state = event.state as Record<string, unknown> | undefined;
        if (state) {
          updateSessionState({
            activeNode: (event.node as string) ?? null,
            taskQueue: (state.task_queue as Record<string, unknown>[]) ?? [],
            botStats: (state.bot_stats as Record<string, Record<string, unknown>>) ?? {},
            cycle: (state.cycle as number) ?? 0,
            isRunning: true,
          });
        }
      } else if (event.type === "session_complete") {
        updateSessionState({ isRunning: false, activeNode: null });
      }
    }
    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // Memory API — success patterns, learning curve, pattern quality
  // -----------------------------------------------------------------------
  fastify.get("/api/memory/success-patterns", async () => {
    const teamConfig = await loadTeamConfig();
    const vectorMemory = new VectorMemory(
      CONFIG.vectorStorePath,
      teamConfig?.memory_backend ?? CONFIG.memoryBackend,
    );
    await vectorMemory.init();
    const db = vectorMemory.getDb();
    const embedder = vectorMemory.getEmbedder();
    if (!db || !embedder) return { patterns: [] };
    const store = new SuccessPatternStore(db, embedder);
    await store.init();
    return { patterns: await store.getAll() };
  });

  fastify.delete("/api/memory/success-patterns/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const teamConfig = await loadTeamConfig();
    const vectorMemory = new VectorMemory(
      CONFIG.vectorStorePath,
      teamConfig?.memory_backend ?? CONFIG.memoryBackend,
    );
    await vectorMemory.init();
    const db = vectorMemory.getDb();
    const embedder = vectorMemory.getEmbedder();
    if (!db || !embedder) return reply.status(500).send({ error: "LanceDB not available" });
    const store = new SuccessPatternStore(db, embedder);
    await store.init();
    const ok = await store.delete(id);
    return ok ? { ok: true } : reply.status(404).send({ error: "Pattern not found" });
  });

  fastify.get("/api/memory/learning-curve", async () => {
    const teamConfig = await loadTeamConfig();
    const vectorMemory = new VectorMemory(
      CONFIG.vectorStorePath,
      teamConfig?.memory_backend ?? CONFIG.memoryBackend,
    );
    await vectorMemory.init();
    const db = vectorMemory.getDb();
    if (!db) return { curves: [] };
    const store = new LearningCurveStore(db);
    await store.init();
    return { curves: await store.getRecent(10) };
  });

  fastify.get("/api/memory/pattern-quality", async () => {
    const teamConfig = await loadTeamConfig();
    const vectorMemory = new VectorMemory(
      CONFIG.vectorStorePath,
      teamConfig?.memory_backend ?? CONFIG.memoryBackend,
    );
    await vectorMemory.init();
    const db = vectorMemory.getDb();
    if (!db) return { qualities: [] };
    // Pattern quality doesn't have a getAll, return empty for now
    return { qualities: [] };
  });

  // -----------------------------------------------------------------------
  // Global Memory API
  // -----------------------------------------------------------------------
  async function getGlobalManager() {
    const teamConfig = await loadTeamConfig();
    const vectorMemory = new VectorMemory(
      CONFIG.vectorStorePath,
      teamConfig?.memory_backend ?? CONFIG.memoryBackend,
    );
    await vectorMemory.init();
    const embedder = vectorMemory.getEmbedder();
    const db = vectorMemory.getDb();
    if (!embedder) throw new Error("Embedder not available");
    const gm = new GlobalMemoryManager();
    await gm.init(embedder);
    return { gm, embedder, db, vectorMemory };
  }

  fastify.get("/api/memory/health", async (_req, reply) => {
    try {
      const { gm } = await getGlobalManager();
      return await computeHealth(gm);
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.get("/api/memory/global/patterns", async (_req, reply) => {
    try {
      const { gm } = await getGlobalManager();
      const store = gm.getPatternStore();
      return { patterns: store ? await store.getAll() : [] };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.get("/api/memory/global/lessons", async (_req, reply) => {
    try {
      const { gm } = await getGlobalManager();
      return { lessons: await gm.getAllLessons() };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.get("/api/memory/global/knowledge-graph", async (_req, reply) => {
    try {
      const { gm } = await getGlobalManager();
      const kg = gm.getKnowledgeGraph();
      return kg ? await kg.getGraph(200) : { nodes: [], edges: [] };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.post("/api/memory/global/promote/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { gm, embedder, db } = await getGlobalManager();
      if (!db) return reply.status(500).send({ error: "LanceDB not available" });
      const sessionStore = new SuccessPatternStore(db, embedder);
      await sessionStore.init();
      const qualityStore = new PatternQualityStore(db);
      await qualityStore.init();
      const promoter = new PromotionEngine(gm, sessionStore, qualityStore, embedder);
      const ok = await promoter.promoteById(id);
      return ok ? { ok: true } : reply.status(404).send({ error: "Pattern not found" });
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.post("/api/memory/global/demote/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { gm } = await getGlobalManager();
      const store = gm.getPatternStore();
      if (!store) return reply.status(500).send({ error: "Global store not available" });
      const ok = await store.delete(id);
      return ok ? { ok: true } : reply.status(404).send({ error: "Pattern not found" });
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.post("/api/memory/global/export", async (_req, reply) => {
    try {
      const { gm } = await getGlobalManager();
      return await exportGlobalMemory(gm);
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.post("/api/memory/global/import", async (req, reply) => {
    try {
      const data = req.body as MemoryExport;
      const { gm, embedder } = await getGlobalManager();
      const result = await importGlobalMemory(gm, data, embedder);
      return result;
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // -----------------------------------------------------------------------
  // Agent Performance Profiles API
  // -----------------------------------------------------------------------
  async function getProfileStore() {
    const { gm } = await getGlobalManager();
    const db = gm.getDb();
    if (!db) throw new Error("Global database not available");
    const store = new ProfileStore();
    await store.init(db);
    return store;
  }

  fastify.get("/api/profiles", async (_req, reply) => {
    try {
      const store = await getProfileStore();
      return { profiles: await store.getAll() };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.get("/api/profiles/routing-decisions", async (_req, reply) => {
    try {
      const state = currentSessionState;
      const decisions = (state as unknown as Record<string, unknown>)?.routing_decisions ?? [];
      return { decisions };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.get("/api/profiles/:role", async (req, reply) => {
    const { role } = req.params as { role: string };
    try {
      const store = await getProfileStore();
      const profile = await store.getByRole(role);
      if (!profile) return reply.status(404).send({ error: "Profile not found" });
      return profile;
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.delete("/api/profiles/:role", async (req, reply) => {
    const { role } = req.params as { role: string };
    try {
      const store = await getProfileStore();
      const ok = await store.delete(role);
      return ok ? { ok: true } : reply.status(404).send({ error: "Profile not found" });
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // Custom agents
  fastify.get("/api/agents/custom", async () => {
    const { AgentRegistryStore } = await import("../agents/registry/index.js");
    const store = new AgentRegistryStore();
    const agents = store.list();
    const defs = store.loadAllSync();
    return {
      agents: agents.map((a) => {
        const def = defs.find((d) => d.role === a.role);
        return {
          ...a,
          taskTypes: def?.taskTypes ?? [],
          compositionRules: def?.compositionRules ?? null,
          confidenceConfig: def?.confidenceConfig ?? null,
        };
      }),
    };
  });

  fastify.delete<{ Params: { role: string } }>("/api/agents/custom/:role", async (req, reply) => {
    const { role } = req.params;
    const { AgentRegistryStore } = await import("../agents/registry/index.js");
    const store = new AgentRegistryStore();
    const removed = store.unregister(role);
    if (!removed) {
      return reply.status(404).send({ error: `Agent not found: ${role}` });
    }
    return { ok: true, role };
  });

  // Audit trails
  fastify.get<{ Params: { sessionId: string } }>("/api/audit/:sessionId", async (req, reply) => {
    const { sessionId } = req.params;
    const { getSession } = await import("../replay/index.js");
    const session = getSession(sessionId);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    const { buildAuditTrail, renderAuditMarkdown } = await import("../audit/index.js");
    const audit = await buildAuditTrail(sessionId, 0, {
      user_goal: session.goal,
      average_confidence: session.averageConfidence,
    }, session.createdAt, session.completedAt, []);
    const markdown = renderAuditMarkdown(audit);
    return { audit, markdown };
  });

  fastify.post<{ Params: { sessionId: string } }>("/api/audit/:sessionId/export", async (req, reply) => {
    const { sessionId } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const format = (body.format as string) ?? "markdown";

    const { getSession } = await import("../replay/index.js");
    const session = getSession(sessionId);
    if (!session) return reply.status(404).send({ error: "Session not found" });

    const { buildAuditTrail, renderAuditMarkdown } = await import("../audit/index.js");
    const audit = await buildAuditTrail(sessionId, 0, {
      user_goal: session.goal,
      average_confidence: session.averageConfidence,
    }, session.createdAt, session.completedAt, []);

    if (format === "markdown") {
      const md = renderAuditMarkdown(audit, { includePrompts: body.includePrompts as boolean ?? false });
      const { writeFile, mkdir } = await import("node:fs/promises");
      const sessionDir = path.join(os.homedir(), ".openpawl", "sessions", sessionId);
      await mkdir(sessionDir, { recursive: true });
      const outPath = path.join(sessionDir, "audit.md");
      await writeFile(outPath, md, "utf-8");
      return { ok: true, path: outPath, format: "markdown" };
    }

    return reply.status(400).send({ error: "Unsupported format. Use: markdown" });
  });

  // Replay sessions
  fastify.get("/api/replay/sessions", async (req) => {
    const { listSessions } = await import("../replay/index.js");
    const limit = parseInt((req.query as Record<string, string>).limit ?? "0", 10) || undefined;
    return { sessions: listSessions(limit) };
  });

  fastify.get<{ Params: { sessionId: string } }>("/api/replay/sessions/:sessionId", async (req, reply) => {
    const { getSession } = await import("../replay/index.js");
    const session = getSession(req.params.sessionId);
    if (!session) return reply.status(404).send({ error: "Session not found" });
    return session;
  });

  fastify.post<{ Params: { sessionId: string } }>("/api/replay/sessions/:sessionId/start", async (req, reply) => {
    const { ReplayEngine } = await import("../replay/index.js");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const options = {
      sessionId: req.params.sessionId,
      runIndex: body.runIndex as number | undefined,
      fromNode: body.fromNode as string | undefined,
      speed: (body.speed as number) ?? 1,
    };
    const engine = new ReplayEngine(options, { emit: (event) => broadcast(event) });
    const loadResult = await engine.load();
    if (!loadResult.ok) return reply.status(400).send({ error: loadResult.error });

    // Run replay in background — don't block the HTTP response
    engine.play().catch(() => {});
    return { ok: true, sessionId: req.params.sessionId };
  });

  fastify.delete<{ Params: { sessionId: string } }>("/api/replay/sessions/:sessionId", async (req, reply) => {
    const { deleteSession } = await import("../replay/index.js");
    const ok = deleteSession(req.params.sessionId);
    if (!ok) return reply.status(404).send({ error: "Session not found" });
    return { ok: true };
  });

  fastify.post<{ Params: { sessionId: string } }>("/api/replay/sessions/:sessionId/tag", async (req, reply) => {
    const { tagSession } = await import("../replay/index.js");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = (body.label as string) ?? "";
    if (!label.trim()) return reply.status(400).send({ error: "Label required" });
    const ok = tagSession(req.params.sessionId, label.trim());
    if (!ok) return reply.status(404).send({ error: "Session not found" });
    return { ok: true };
  });

  fastify.delete<{ Params: { sessionId: string } }>("/api/replay/sessions/:sessionId/tag", async (req, reply) => {
    const { untagSession } = await import("../replay/index.js");
    const ok = untagSession(req.params.sessionId);
    if (!ok) return reply.status(404).send({ error: "Session not found" });
    return { ok: true };
  });

  fastify.get<{ Params: { sessionId: string } }>("/api/replay/sessions/:sessionId/export", async (req, reply) => {
    const { exportSession } = await import("../replay/index.js");
    const data = await exportSession(req.params.sessionId);
    if (!data.session) return reply.status(404).send({ error: "Session not found" });
    return data;
  });

  // Heatmap API — agent utilization
  fastify.get<{ Params: { sessionId: string } }>("/api/heatmap/:sessionId", async (req, reply) => {
    try {
      const { getSession } = await import("../replay/index.js");
      const { readRecordingEvents } = await import("../replay/storage.js");
      const { calculateUtilization } = await import("../heatmap/calculator.js");
      const { buildHeatmap } = await import("../heatmap/builder.js");

      const query = req.query as Record<string, string>;
      const session = getSession(req.params.sessionId);
      if (!session) return reply.status(404).send({ error: "Session not found" });

      const events = await readRecordingEvents(req.params.sessionId);
      const run = parseInt(query.run ?? String(session.totalRuns || 1), 10);
      const metric = (query.metric as "duration" | "cost" | "confidence") ?? "duration";

      const utilizations = calculateUtilization(req.params.sessionId, run, events);
      const heatmap = buildHeatmap(utilizations, "run", { metric });
      return heatmap;
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // Diff API — compare runs within a session
  fastify.get<{ Params: { sessionId: string } }>("/api/diff/:sessionId", async (req, reply) => {
    try {
      const { getSession } = await import("../replay/index.js");
      const { readRecordingEvents } = await import("../replay/storage.js");
      const { extractRunSnapshot } = await import("../diff/engine.js");
      const { buildDiffChain } = await import("../diff/chain.js");

      const session = getSession(req.params.sessionId);
      if (!session) return reply.status(404).send({ error: "Session not found" });
      if (session.totalRuns < 2) return reply.status(400).send({ error: "Need at least 2 runs to diff" });

      const events = await readRecordingEvents(req.params.sessionId);
      const snapshots = [];
      for (let i = 1; i <= session.totalRuns; i++) {
        const runEvents = events.filter((e) => e.runIndex === i);
        const exits = runEvents.filter((e) => e.phase === "exit");
        const enters = runEvents.filter((e) => e.phase === "enter");
        const state = exits[exits.length - 1]?.stateAfter ?? {};
        const start = enters[0]?.timestamp ?? 0;
        const end = exits[exits.length - 1]?.timestamp ?? start;
        snapshots.push(extractRunSnapshot(req.params.sessionId, i, state, start, end));
      }

      const chain = buildDiffChain(snapshots);
      return chain;
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // Composition history
  fastify.get("/api/composition-history", async (_req, reply) => {
    try {
      const { gm } = await getGlobalManager();
      const db = gm.getDb();
      if (!db) return { history: [] };
      const { CompositionHistoryStore } = await import("../agents/composition/history.js");
      const store = new CompositionHistoryStore();
      await store.init(db);
      return { history: await store.getRecent(10) };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // Think (Rubber Duck Mode)
  // ---------------------------------------------------------------------------
  const thinkSessions = new Map<string, import("../think/types.js").ThinkSession>();
  const thinkSessionActivity = new Map<string, number>();

  // Clean up expired sessions every 30 minutes
  const thinkCleanupInterval = setInterval(() => {
    const now = Date.now();
    const THIRTY_MINUTES = 30 * 60 * 1000;
    for (const [id] of thinkSessions) {
      const lastActivity = thinkSessionActivity.get(id) ?? 0;
      if (now - lastActivity > THIRTY_MINUTES) {
        thinkSessions.delete(id);
        thinkSessionActivity.delete(id);
      }
    }
  }, 30 * 60 * 1000);
  // Prevent interval from keeping process alive
  thinkCleanupInterval.unref();

  fastify.post<{ Body: { question: string } }>("/api/think", async (req, reply) => {
    const { question } = req.body ?? {} as { question?: string };
    if (!question?.trim()) {
      return reply.status(400).send({ error: "Question is required" });
    }

    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      raw.write(`data: ${JSON.stringify({ event, data })}\n\n`);
    };

    try {
      const { loadThinkContext } = await import("../think/context-loader.js");
      const { executeThinkRound } = await import("../think/executor.js");
      const { randomUUID } = await import("node:crypto");

      // Load context first and emit context_loaded before streaming
      const context = await loadThinkContext(question);
      send("context_loaded", { relevantDecisions: context.relevantDecisions.length });

      let currentStage = "";
      const round = await executeThinkRound(question, context, {
        onChunk: (stage, content) => {
          if (stage !== currentStage) {
            currentStage = stage;
            if (stage !== "coordinator") send(`${stage}_start`, {});
          }
          if (stage !== "coordinator") send(`${stage}_chunk`, { content });
        },
      });

      const session: import("../think/types.js").ThinkSession = {
        id: `think-${randomUUID().slice(0, 8)}`,
        question,
        context,
        rounds: [round],
        recommendation: round.recommendation,
        savedToJournal: false,
        createdAt: Date.now(),
      };

      if (round) {
        send("tech_lead_done", { perspective: round.techLeadPerspective });
        send("rfc_author_done", { perspective: round.rfcAuthorPerspective });
      }

      if (session.recommendation) {
        send("recommendation", { recommendation: session.recommendation });
      }

      thinkSessions.set(session.id, session);
      thinkSessionActivity.set(session.id, Date.now());
      send("done", { sessionId: session.id });
    } catch (err) {
      send("error", { stage: "session", message: String(err) });
    }

    raw.end();
  });

  fastify.post<{ Params: { sessionId: string }; Body: { question: string } }>(
    "/api/think/:sessionId/followup",
    async (req, reply) => {
      const { sessionId } = req.params;
      const { question } = req.body ?? {} as { question?: string };

      const session = thinkSessions.get(sessionId);
      if (!session) {
        return reply.status(404).send({ error: "Think session not found or expired" });
      }

      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (event: string, data: unknown) => {
        raw.write(`data: ${JSON.stringify({ event, data })}\n\n`);
      };

      try {
        const { addFollowUp } = await import("../think/session.js");
        let currentStage = "";
        const updated = await addFollowUp(session, question, {
          onChunk: (stage, content) => {
            if (stage !== currentStage) {
              currentStage = stage;
              if (stage !== "coordinator") send(`${stage}_start`, {});
            }
            if (stage !== "coordinator") send(`${stage}_chunk`, { content });
          },
        });

        const lastRound = updated.rounds[updated.rounds.length - 1];
        if (lastRound) {
          send("tech_lead_done", { perspective: lastRound.techLeadPerspective });
          send("rfc_author_done", { perspective: lastRound.rfcAuthorPerspective });
        }
        if (updated.recommendation) {
          send("recommendation", { recommendation: updated.recommendation });
        }

        thinkSessions.set(sessionId, updated);
        thinkSessionActivity.set(sessionId, Date.now());
        send("done", { sessionId });
      } catch (err) {
        send("error", { stage: "followup", message: String(err) });
      }

      raw.end();
    },
  );

  // Save think session to journal
  fastify.post<{ Params: { sessionId: string } }>(
    "/api/think/:sessionId/save",
    async (req, reply) => {
      const session = thinkSessions.get(req.params.sessionId);
      if (!session) {
        return reply.status(404).send({ error: "Think session not found" });
      }
      try {
        const { saveToJournal, recordToHistory } = await import("../think/session.js");
        const saved = await saveToJournal(session);
        await recordToHistory(saved);
        thinkSessions.set(req.params.sessionId, saved);
        return { success: true, choice: saved.recommendation?.choice };
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Async Think Jobs
  // ---------------------------------------------------------------------------

  fastify.get("/api/think/async/jobs", async () => {
    try {
      const { AsyncThinkJobStore } = await import("../think/job-store.js");
      const store = new AsyncThinkJobStore();
      const jobs = store.list();
      return {
        jobs: jobs.map((j) => ({
          jobId: j.id,
          question: j.question,
          status: j.status,
          recommendation: j.result?.recommendation?.choice ?? null,
          confidence: j.result?.recommendation?.confidence ?? null,
          completedAt: j.completedAt,
          savedToJournal: j.result?.savedToJournal ?? false,
          createdAt: j.createdAt,
          error: j.error,
        })),
      };
    } catch (err) {
      return { jobs: [], error: String(err) };
    }
  });

  fastify.post<{ Body: { question: string; autoSave?: boolean } }>(
    "/api/think/async",
    async (req, reply) => {
      const { question, autoSave } = req.body ?? {} as { question?: string; autoSave?: boolean };
      if (!question?.trim()) {
        return reply.status(400).send({ error: "Question is required" });
      }
      try {
        const { launchAsyncThink } = await import("../think/background-executor.js");
        const result = await launchAsyncThink(question.trim(), { autoSave: autoSave ?? true });
        if (!result.ok) {
          return reply.status(429).send({ error: result.error });
        }
        return {
          jobId: result.job!.id,
          question: result.job!.question,
          status: result.job!.status,
        };
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  fastify.get<{ Params: { jobId: string } }>(
    "/api/think/async/:jobId",
    async (req, reply) => {
      try {
        const { AsyncThinkJobStore } = await import("../think/job-store.js");
        const store = new AsyncThinkJobStore();
        const job = store.get(req.params.jobId);
        if (!job) {
          return reply.status(404).send({ error: "Job not found" });
        }
        return job;
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  fastify.post<{ Params: { jobId: string } }>(
    "/api/think/async/:jobId/cancel",
    async (req, reply) => {
      try {
        const { AsyncThinkJobStore } = await import("../think/job-store.js");
        const store = new AsyncThinkJobStore();
        const job = store.get(req.params.jobId);
        if (!job) {
          return reply.status(404).send({ error: "Job not found" });
        }
        if (job.status !== "running" && job.status !== "queued") {
          return reply.status(400).send({ error: `Job is ${job.status}` });
        }
        if (job.pid !== null) {
          try { process.kill(job.pid, "SIGTERM"); } catch { /* gone */ }
        }
        job.status = "cancelled";
        job.completedAt = Date.now();
        store.save(job);
        return { success: true, status: "cancelled" };
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // ── Vibe score endpoint ──────────────────────────────────────────
  fastify.get("/api/score", async (_req, reply) => {
    try {
      const lancedb = await import("@lancedb/lancedb");
      const dbPath = path.join(os.homedir(), ".openpawl", "memory", "global.db");
      const db = await lancedb.connect(dbPath);
      const { VibeScoreStore } = await import("../score/store.js");
      const { calculateTrend } = await import("../score/trends.js");
      const store = new VibeScoreStore();
      await store.init(db);
      const latest = await store.getLatest();
      const recent = await store.getRecent(28);
      const trend = calculateTrend(recent);
      return { score: latest, trend };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ── Standup endpoint ──────────────────────────────────────────────
  fastify.get("/api/standup", async (req, reply) => {
    try {
      const { collectStandupData } = await import("../standup/collector.js");
      const { generateSuggestions } = await import("../standup/suggester.js");

      const sinceParam = (req.query as Record<string, string>).since ?? "24h";
      const match = sinceParam.match(/^(\d+)([dhw])$/);
      let ms = 24 * 60 * 60 * 1000;
      if (match) {
        const [, n, unit] = match;
        const num = Number(n);
        if (unit === "h") ms = num * 60 * 60 * 1000;
        else if (unit === "d") ms = num * 24 * 60 * 60 * 1000;
        else if (unit === "w") ms = num * 7 * 24 * 60 * 60 * 1000;
      }

      const data = await collectStandupData({ since: Date.now() - ms, label: sinceParam });
      data.suggested = generateSuggestions(data.blocked, data.yesterday.sessions);
      return { data };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ── Handoff endpoints ──────────────────────────────────────────────
  fastify.get("/api/handoff", async (_req, reply) => {
    try {
      const { listSessions } = await import("../replay/session-index.js");
      const { readRecordingEvents } = await import("../replay/storage.js");
      const { buildHandoffData } = await import("../handoff/collector.js");

      const sessions = listSessions(5);
      const last = sessions.find((s) => s.completedAt > 0);
      if (!last) return reply.status(404).send({ error: "No completed sessions" });

      let finalState: Record<string, unknown> = {};
      try {
        const events = await readRecordingEvents(last.sessionId);
        const exitEvents = events.filter((e) => e.phase === "exit");
        const lastExit = exitEvents[exitEvents.length - 1];
        finalState = (lastExit?.stateAfter ?? {}) as Record<string, unknown>;
      } catch { /* recording may be missing */ }

      let activeDecisions: import("../journal/types.js").Decision[] = [];
      try {
        const { VectorMemory } = await import("../core/knowledge-base.js");
        const { CONFIG } = await import("../core/config.js");
        const { GlobalMemoryManager } = await import("../memory/global/store.js");
        const { DecisionStore } = await import("../journal/store.js");
        const vm = new VectorMemory(CONFIG.vectorStorePath, CONFIG.memoryBackend);
        await vm.init();
        const embedder = vm.getEmbedder();
        if (embedder) {
          const globalMgr = new GlobalMemoryManager();
          await globalMgr.init(embedder);
          const db = globalMgr.getDb();
          if (db) {
            const store = new DecisionStore();
            await store.init(db);
            const recent = await store.getRecentDecisions(30);
            activeDecisions = recent.filter((d) => d.status === "active");
          }
        }
      } catch { /* non-critical */ }

      const data = buildHandoffData({
        sessionId: last.sessionId,
        projectPath: process.cwd(),
        goal: last.goal || "Unknown goal",
        taskQueue: (finalState.task_queue ?? []) as Array<Record<string, unknown>>,
        nextSprintBacklog: (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>,
        promotedThisRun: (finalState.promoted_this_run ?? []) as string[],
        agentProfiles: (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>,
        activeDecisions,
        rfcDocument: (finalState.rfc_document as string) ?? null,
      });

      return data;
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.post("/api/handoff/generate", async (_req, reply) => {
    try {
      const { listSessions } = await import("../replay/session-index.js");
      const { readRecordingEvents } = await import("../replay/storage.js");
      const { buildHandoffData } = await import("../handoff/collector.js");
      const { renderContextMarkdown } = await import("../handoff/renderer.js");
      const { DEFAULT_HANDOFF_CONFIG } = await import("../handoff/types.js");

      const sessions = listSessions(5);
      const last = sessions.find((s) => s.completedAt > 0);
      if (!last) return reply.status(404).send({ error: "No completed sessions" });

      let finalState: Record<string, unknown> = {};
      try {
        const events = await readRecordingEvents(last.sessionId);
        const exitEvents = events.filter((e) => e.phase === "exit");
        const lastExit = exitEvents[exitEvents.length - 1];
        finalState = (lastExit?.stateAfter ?? {}) as Record<string, unknown>;
      } catch { /* */ }

      const data = buildHandoffData({
        sessionId: last.sessionId,
        projectPath: process.cwd(),
        goal: last.goal || "Unknown goal",
        taskQueue: (finalState.task_queue ?? []) as Array<Record<string, unknown>>,
        nextSprintBacklog: (finalState.next_sprint_backlog ?? []) as Array<Record<string, unknown>>,
        promotedThisRun: (finalState.promoted_this_run ?? []) as string[],
        agentProfiles: (finalState.agent_profiles ?? []) as Array<Record<string, unknown>>,
        activeDecisions: [],
        rfcDocument: (finalState.rfc_document as string) ?? null,
      });

      const markdown = renderContextMarkdown(data);
      const outPath = path.resolve(DEFAULT_HANDOFF_CONFIG.outputPath);
      await writeFile(outPath, markdown, "utf-8");

      const sessionDir = path.join(os.homedir(), ".openpawl", "sessions", last.sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(path.join(sessionDir, "CONTEXT.md"), markdown, "utf-8");

      return { path: outPath, markdown };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  fastify.post("/api/handoff/import", async (_req, reply) => {
    try {
      const { importContextFile } = await import("../handoff/importer.js");
      const contextPath = path.resolve("CONTEXT.md");
      const result = await importContextFile(contextPath);
      if (!result) return reply.status(404).send({ error: "No CONTEXT.md found" });
      return result;
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // SPA fallback AFTER all API routes
  if (clientDir) {
    fastify.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET") return reply.status(404).send();
      if (request.url.startsWith("/api")) {
        return reply.status(404).send();
      }
      const lastSegment = request.url.split("/").pop() ?? "";
      if (lastSegment.includes(".")) {
        return reply.status(404).send();
      }
      return reply.sendFile("index.html", clientDir);
    });
  }

  try {
    await fastify.listen({ port, host: "0.0.0.0" });

    // Verify the server is actually reachable before declaring it live
    const url = `http://localhost:${port}`;
    let alive = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const resp = await fetch(`${url}/api/memory/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok) { alive = true; break; }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (!alive) {
      const msg = `Server started but ${url} is not responding — check firewall or port conflicts`;
      if (s) { s.stop(msg); }
      else { logger.error(msg); }
      process.exit(1);
    }

    if (s) {
      s.stop("Web Server is live!");
      note(`Access the dashboard at: ${url}`, "OpenPawl Web UI");
    } else {
      logger.success(`Web UI: ${url}`);
    }
  } catch (err) {
    if (s) {
      s.stop(`Web server failed to start: ${String(err)}`);
    }
    throw err;
  }
}
