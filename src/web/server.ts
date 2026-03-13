/**
 * Fastify server for TeamClaw web UI.
 * Serves static HTML and streams workflow events via WebSocket.
 */

import Fastify from "fastify";
import FastifyCors from "@fastify/cors";
import FastifyStatic from "@fastify/static";
import FastifyWebSocket from "@fastify/websocket";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTeamOrchestration } from "../core/simulation.js";
import { buildTeamFromRoster, buildTeamFromTemplate } from "../core/team-templates.js";
import type { ApprovalPending, ApprovalResponse } from "../agents/approval.js";
import {
  getWorkerUrlsForTeam,
  setSessionConfig,
  clearSessionConfig,
  type SessionConfig,
} from "../core/config.js";
import { loadTeamConfig, clearTeamConfigCache } from "../core/team-config.js";
import { writeFile } from "node:fs/promises";
import { VectorMemory } from "../core/knowledge-base.js";
import { PostMortemAnalyst } from "../agents/analyst.js";
import { CONFIG } from "../core/config.js";
import type { GraphState } from "../core/graph-state.js";
import {
  fireTaskCompleteWebhook,
  fireCycleEndWebhook,
} from "./webhooks.js";
import { provisionOpenClaw } from "../core/provisioning.js";
import { validateStartup } from "../core/startup-validation.js";
import { getTeamTemplate } from "../core/team-templates.js";
import { logger } from "../core/logger.js";
import { ensureWorkspaceDir } from "../core/workspace-fs.js";
import { addTerminalClient, removeTerminalClient, initTerminalBroadcast } from "../core/terminal-broadcast.js";
import { log, note, spinner } from "@clack/prompts";
import { findAvailablePort } from "../core/port.js";
import { WsEventSchema } from "../interfaces/ws-events.js";
import { humanResponseEmitter } from "../core/human-response-events.js";
import { getDefaultGoal } from "../core/configManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isProduction = process.env.NODE_ENV === "production";

const clients = new Set<WebSocket>();

interface SessionState {
  activeNode: string | null;
  cycle: number;
  taskQueue: Record<string, unknown>[];
  botStats: Record<string, Record<string, unknown>>;
  isRunning: boolean;
  generation: number;
}

let currentSessionState: SessionState = {
  activeNode: null,
  cycle: 0,
  taskQueue: [],
  botStats: {},
  isRunning: false,
  generation: 0,
};

function broadcast(event: object): void {
  const data = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function updateSessionState(updates: Partial<SessionState>): void {
  currentSessionState = { ...currentSessionState, ...updates };
}

function sendStateSync(socket: WebSocket): void {
  socket.send(
    JSON.stringify({
      type: "state_sync",
      state: {
        activeNode: currentSessionState.activeNode,
        cycle: currentSessionState.cycle,
        taskQueue: currentSessionState.taskQueue,
        botStats: currentSessionState.botStats,
        isRunning: currentSessionState.isRunning,
        generation: currentSessionState.generation,
      },
    })
  );
}

function resolveClientDir(): string | null {
  const candidates = [
    // Built runtime: dist/web/server.js -> dist/client
    path.join(__dirname, "..", "client"),
    // Source runtime fallback: src/web/server.ts -> src/web/client/dist
    path.join(__dirname, "client", "dist"),
    // Legacy fallback
    path.join(__dirname, "client"),
  ];
  for (const p of candidates) {
    if (existsSync(path.join(p, "index.html"))) {
      return p;
    }
  }
  return null;
}

let cliCycles = CONFIG.maxCycles;
let cliGenerations = CONFIG.maxRuns;
let cliCreativity = CONFIG.creativity;

function getFullConfig(): Record<string, number | string> {
  return {
    creativity: cliCreativity,
    max_cycles: cliCycles,
    max_generations: cliGenerations,
    worker_url: CONFIG.openclawWorkerUrl || "",
  };
}

function applyConfigOverrides(overrides: Partial<SessionConfig> & Record<string, unknown>): void {
  if (typeof overrides.max_cycles === "number") cliCycles = overrides.max_cycles;
  if (typeof overrides.max_generations === "number") cliGenerations = overrides.max_generations;
  if (typeof overrides.creativity === "number")
    cliCreativity = Math.max(0, Math.min(1, overrides.creativity));
}

interface SessionControl {
  speedFactor: number;
  paused: boolean;
  cancelled: boolean;
}

type ThreadRegistryEntry = {
  orch: ReturnType<typeof createTeamOrchestration>;
};

const THREAD_REGISTRY = new Map<string, ThreadRegistryEntry>();
let timeoutCheckerStarted = false;

function startTimeoutChecker(): void {
  if (timeoutCheckerStarted) return;
  timeoutCheckerStarted = true;
  const intervalMs = 10000;
  setInterval(async () => {
    if (THREAD_REGISTRY.size === 0) return;
    for (const [threadId, entry] of THREAD_REGISTRY.entries()) {
      try {
        const config = { configurable: { thread_id: threadId } };
        const snapshot = await entry.orch.graph.getState(config);
        const values = (snapshot as { values?: Record<string, unknown> }).values ?? {};
        const taskQueue = (values.task_queue ?? []) as Record<string, unknown>[];
        if (!Array.isArray(taskQueue) || taskQueue.length === 0) continue;

        const now = Date.now();
        let updated = false;
        const updatedQueue = taskQueue.map((task) => {
          const status = task.status as string | undefined;
          if (status !== "in_progress") return task;
          const startedAtRaw = task.in_progress_at as string | null | undefined;
          const startedAtMs =
            typeof startedAtRaw === "string" && startedAtRaw
              ? Date.parse(startedAtRaw)
              : Number.NaN;
          const rawTimebox = Number(task.timebox_minutes ?? 25);
          const timeboxMinutes =
            Number.isFinite(rawTimebox) && rawTimebox >= 1 ? rawTimebox : 25;
          if (!Number.isFinite(startedAtMs)) return task;
          const limitMs = timeboxMinutes * 60_000;
          const elapsedMs = now - startedAtMs;
          if (elapsedMs >= limitMs && (task.status as string) !== "TIMEOUT_WARNING") {
            updated = true;
            return {
              ...task,
              status: "TIMEOUT_WARNING",
            };
          }
          return task;
        });

        if (!updated) continue;

        await entry.orch.graph.updateState(config, { task_queue: updatedQueue });
        broadcast({
          type: "task_queue_updated",
          task_queue: updatedQueue,
        });
        broadcast({
          type: "timeout_alert",
          task_queue: updatedQueue,
        });
      } catch {
        // Best-effort timeout checking; ignore errors.
      }
    }
  }, intervalMs);
}

function parseNodeEvent(
  nodeName: string,
  state: Record<string, unknown>
): Record<string, unknown> {
  const botStats = (state.bot_stats ?? {}) as Record<string, Record<string, unknown>>;
  const totalDone = Object.values(botStats).reduce(
    (s, x) => s + ((x?.tasks_completed as number) ?? 0),
    0
  );
  const totalFailed = Object.values(botStats).reduce(
    (s, x) => s + ((x?.tasks_failed as number) ?? 0),
    0
  );
  const snapshot = {
    cycle: state.cycle_count ?? 0,
    tasks_completed: totalDone,
    tasks_failed: totalFailed,
    last_quality_score: state.last_quality_score ?? 0,
    agent_messages: state.agent_messages ?? [],
    task_queue: state.task_queue ?? [],
    bot_stats: state.bot_stats ?? {},
  };

  let data: Record<string, unknown> = { message: `${nodeName} executed` };

  if (nodeName === "coordinator") {
    const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
    const pending = taskQueue.filter((t) => t.status === "pending").length;
    data = {
      message: `Coordinator processed, ${pending} tasks pending`,
      pending_count: pending,
    };
  } else if (nodeName === "worker_execute") {
    const taskQueue = (state.task_queue ?? []) as Record<string, unknown>[];
    const lastTask =
      [...taskQueue].reverse().find((t) =>
        ["completed", "failed"].includes((t.status as string) ?? "")
      ) ?? {};
    const result = (lastTask.result ?? {}) as Record<string, unknown>;
    data = {
      task_id: lastTask.task_id ?? "",
      success: result.success ?? false,
      quality_score: result.quality_score ?? 0,
      assigned_to: lastTask.assigned_to ?? "",
      output: result.output ?? "",
      description: lastTask.description ?? "",
      message: result.success ? "✅ Task completed" : "❌ Task completed",
    };
  } else if (nodeName === "approval") {
    const pending = state.approval_pending as Record<string, unknown> | null;
    const resp = state.approval_response as Record<string, unknown> | null;
    data = {
      message: resp?.action ? `Approval: ${resp.action}` : "Awaiting approval",
      approval_pending: pending,
      approval_response: resp,
    };
  } else if (nodeName === "increment_cycle") {
    data = {
      cycle: state.cycle_count ?? 0,
      message: `Cycle ${state.cycle_count ?? 0} completed`,
    };
  }

  const botActions = getBotActions(nodeName, data);
  return {
    node: nodeName,
    data,
    state: snapshot,
    bot_actions: botActions,
    timestamp: new Date().toTimeString().slice(0, 8),
  };
}

function getBotActions(nodeName: string, data: Record<string, unknown>): unknown[] {
  if (nodeName === "coordinator") {
    return [{ bot: "ceo", action: "walk_to", target: "meeting_table", then: "thinking" }];
  }
  if (nodeName === "worker_execute") {
    const success = data.success ?? false;
    const actions: unknown[] = [
      { bot: "sparki", action: "walk_to", target: "desk", then: "working" },
      { bot: "ceo", action: "idle", floor: 3 },
    ];
    if (success) {
      actions.push({ bot: "sparki", action: "celebrate", delay: 1.5 });
    } else {
      actions.push({ bot: "sparki", action: "react", emotion: "worried", delay: 1.5 });
    }
    return actions;
  }
  if (nodeName === "approval") {
    return [{ bot: "ceo", action: "wait", target: "approval" }];
  }
  if (nodeName === "increment_cycle") {
    return [
      { bot: "ceo", action: "return_to_office" },
      { bot: "sparki", action: "idle", floor: 2 },
    ];
  }
  return [];
}

function buildWsValidationError(
  detail: string,
  issues: unknown = null,
): { type: "system"; payload: Record<string, unknown> } {
  return {
    type: "system",
    payload: {
      error: true,
      code: "INVALID_WS_PAYLOAD",
      message: detail,
      issues,
      timestamp: new Date().toISOString(),
    },
  };
}

function normalizeIncomingWsMessage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const raw = value as Record<string, unknown>;
  const eventType = typeof raw.type === "string" ? raw.type : "";
  const alreadyEnvelope =
    ["telemetry", "terminal_out", "worker_status", "system"].includes(eventType) &&
    Object.prototype.hasOwnProperty.call(raw, "payload");
  if (alreadyEnvelope) return value;

  if (typeof raw.command === "string") {
    return {
      type: "system",
      payload: raw,
    };
  }

  if (raw.type === "UPDATE_TASK") {
    return {
      type: "worker_status",
      payload: raw,
    };
  }

  return value;
}

export async function runWeb(args: string[]): Promise<void> {
  const canRenderSpinner = Boolean(process.stdout.isTTY && process.stderr.isTTY);
  const s = canRenderSpinner ? spinner() : null;
  if (s) {
    s.start("🌐 Booting up Web UI environment...");
  }

  initTerminalBroadcast();
  startTimeoutChecker();
  const result = await validateStartup({ templateId: "game_dev" });
  if (!result.ok) {
    if (s) {
      s.stop(`❌ Web server failed to start: ${result.message}`);
    }
    logger.error(result.message);
    process.exit(1);
  }

  await ensureWorkspaceDir(CONFIG.workspaceDir);
  if (s) {
    s.message("🌐 Initializing Vector Memory and workspace...");
  }

  let requestedPort = 8000;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) {
      requestedPort = parseInt(args[i + 1], 10) || 8000;
      i++;
    }
  }
  const port = await findAvailablePort(requestedPort);
  if (canRenderSpinner && port !== requestedPort) {
    log.info(`Port ${requestedPort} is in use, trying ${port}...`);
  }

  const fastify = Fastify({ logger: false });
  if (s) {
    s.message("🌐 Configuring HTTP server and routes...");
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
      "Web client build not found. Run `pnpm run client:build` to serve the dashboard UI.",
    );
  }

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

  fastify.post("/api/config", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const template = (body.template as string)?.trim() || "game_dev";
    const roster = Array.isArray(body.roster) ? (body.roster as unknown[]) : undefined;
    const goal = (body.goal as string)?.trim() || "";
    const workerUrl = (body.worker_url as string)?.trim() || "";
    const workers = body.workers as Record<string, string> | undefined;
    const configPath = path.join(process.cwd(), "teamclaw.config.json");
    const config: Record<string, unknown> = roster ? { roster, goal } : { template, goal };
    if (workerUrl) config.worker_url = workerUrl;
    if (workers && Object.keys(workers).length > 0) config.workers = workers;
    try {
      await writeFile(configPath, JSON.stringify(config, null, 2));
      clearTeamConfigCache();
      return { ok: true, path: configPath };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: String(err) });
    }
  });

  await fastify.register(FastifyWebSocket);

  fastify.get("/ws", { websocket: true }, async (socket) => {
    clients.add(socket);
    const sendFn = (data: string) => socket.send(data);
    addTerminalClient(sendFn);

    sendStateSync(socket);

    socket.on("close", () => {
      clients.delete(socket);
      removeTerminalClient(sendFn);
    });

    socket.on("error", () => {
      clients.delete(socket);
      removeTerminalClient(sendFn);
    });

    const ctrl: SessionControl = {
      speedFactor: 1.0,
      paused: true,
      cancelled: false,
    };

    let approvalResolve: ((r: ApprovalResponse) => void) | null = null;
    let runThreadId: string | null = null;
    let currentOrch: ReturnType<typeof createTeamOrchestration> | null = null;
    const approvalProvider = (pending: ApprovalPending): Promise<ApprovalResponse> =>
      new Promise((resolve) => {
        approvalResolve = resolve;
        socket.send(JSON.stringify({ type: "approval_request", pending }));
      });

    socket.on("message", async (raw: Buffer | string) => {
      const data = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(data) as unknown;
      } catch {
        socket.send(
          JSON.stringify(buildWsValidationError("Incoming WS payload must be valid JSON.")),
        );
        return;
      }

      const normalized = normalizeIncomingWsMessage(parsedJson);
      const parsedEvent = WsEventSchema.safeParse(normalized);
      if (!parsedEvent.success) {
        socket.send(
          JSON.stringify(
            buildWsValidationError(
              "Incoming WS payload failed schema validation.",
              parsedEvent.error.issues,
            ),
          ),
        );
        return;
      }

      const payload = parsedEvent.data.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        socket.send(
          JSON.stringify(
            buildWsValidationError("Incoming WS payload must be an object."),
          ),
        );
        return;
      }

      const msg = payload as Record<string, unknown>;

      const cmd = msg.command;
      if (cmd === "pause") ctrl.paused = true;
      else if (cmd === "resume") ctrl.paused = false;
      else if (cmd === "speed") {
        const v = Number(msg.value ?? 1);
        ctrl.speedFactor = Math.max(0.25, Math.min(5, v));
      } else if (cmd === "config") {
        applyConfigOverrides((msg.values as Record<string, unknown>) ?? {});
        broadcast({ type: "config_updated", config: getFullConfig() });
      } else if (cmd === "cancel") {
        ctrl.cancelled = true;
        ctrl.paused = false;
      } else if (cmd === "approval_response") {
        const action = (msg.action as string) ?? "approved";
        const payload = msg as Record<string, unknown>;
        const feedback = payload.feedback as string | undefined;
        const taskId = payload.task_id as string | undefined;
        
        humanResponseEmitter.emitResponse({
          action: action as "approved" | "edited" | "feedback",
          feedback,
          taskId,
        });
        
        if (approvalResolve) {
          approvalResolve({
            action: action as ApprovalResponse["action"],
            edited_task: payload.edited_task as { description: string } | undefined,
            feedback,
          });
          approvalResolve = null;
        }
      } else if (msg.type === "UPDATE_TASK" && runThreadId && currentOrch) {
        const taskId = msg.taskId as string;
        const updates = (msg.updates as Record<string, unknown>) ?? {};
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
          socket.send(JSON.stringify({ type: "error", message: `Invalid status: ${status}` }));
          return;
        }
        try {
          const config = { configurable: { thread_id: runThreadId } };
          const snapshot = await currentOrch.graph.getState(config);
          const values = (snapshot as { values?: Record<string, unknown> }).values ?? {};
          const taskQueue = (values.task_queue ?? []) as Record<string, unknown>[];
          const idx = taskQueue.findIndex((t) => (t.task_id as string) === taskId);
          if (idx < 0) {
            socket.send(JSON.stringify({ type: "error", message: `Task not found: ${taskId}` }));
            return;
          }
          const updatedTask = { ...taskQueue[idx] };
          if (status !== undefined) updatedTask.status = status;
          if (priority !== undefined) updatedTask.priority = priority;
          if (assigned_to !== undefined) updatedTask.assigned_to = assigned_to;
          if (urgency !== undefined) {
            const raw = Number(urgency);
            if (Number.isFinite(raw)) {
              const clamped = Math.min(10, Math.max(1, raw));
              updatedTask.urgency = clamped;
            }
          }
          if (importance !== undefined) {
            const raw = Number(importance);
            if (Number.isFinite(raw)) {
              const clamped = Math.min(10, Math.max(1, raw));
              updatedTask.importance = clamped;
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
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: String((err as Error).message ?? err),
            })
          );
        }
      } else if (cmd === "start") {
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
        const workerUrlOverride = (msg.worker_url as string)?.trim() || undefined;

        broadcast({ type: "config_updated", config: getFullConfig() });

        if (getTeamTemplate(teamTemplate) === null) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: "Invalid template. Use game_dev, startup, or content.",
            })
          );
          return;
        }

        (async () => {
          const openclawUrl =
            workerUrlOverride?.trim() ||
            (teamConfig?.worker_url as string | undefined)?.trim() ||
            CONFIG.openclawWorkerUrl?.trim();
          if (!openclawUrl) {
            broadcast({
              type: "provision_error",
              error: "❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.",
            });
            return;
          }
          const provisionResult = await provisionOpenClaw({ workerUrl: openclawUrl });
          if (!provisionResult.ok) {
            const detail = provisionResult.error ?? "unknown error";
            logger.warn(`OpenClaw provisioning failed: ${detail}`);
            broadcast({
              type: "provision_error",
              error: `❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function. Details: ${detail}`,
            });
            return;
          }

          const vectorMemory = new VectorMemory(
            CONFIG.vectorStorePath,
            teamConfig?.memory_backend ?? CONFIG.memoryBackend
          );
          await vectorMemory.init();
          const analyst = new PostMortemAnalyst(vectorMemory);

          for (let genId = 1; genId <= cliGenerations; genId++) {
            if (ctrl.cancelled) break;

            const priorLessons = await vectorMemory.getCumulativeLessons();
            broadcast({
              type: "generation_start",
              generation: genId,
              max_generations: cliGenerations,
              lessons_count: priorLessons.length,
            });
            updateSessionState({ generation: genId, isRunning: true, activeNode: null, cycle: 0 });

            const team =
              teamConfig?.roster && teamConfig.roster.length > 0
                ? buildTeamFromRoster(teamConfig.roster)
                : buildTeamFromTemplate(teamTemplate);
            const workerUrls = getWorkerUrlsForTeam(team.map((b) => b.id), {
              singleUrl: workerUrlOverride || teamConfig?.worker_url,
              workers: workerUrlOverride || teamConfig?.worker_url ? undefined : teamConfig?.workers,
            });
            const orch = createTeamOrchestration({
              team,
              workerUrls,
              approvalProvider,
            });
            runThreadId = randomUUID();
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
                if (ctrl.cancelled) break;
                while (ctrl.paused && !ctrl.cancelled) {
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
                  setTimeout(r, 300 / ctrl.speedFactor)
                );
              }
            } catch (err) {
              broadcast({ type: "error", message: String(err) });
              break;
            }

            if (ctrl.cancelled) {
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

            await new Promise((r) => setTimeout(r, 1000));
          }

          if (!ctrl.cancelled) {
            broadcast({ type: "session_complete" });
          }
          if (runThreadId) {
            THREAD_REGISTRY.delete(runThreadId);
          }
          runThreadId = null;
          currentOrch = null;
          updateSessionState({ isRunning: false, activeNode: null });
          clearSessionConfig();
        })();
      }
    });

    const teamConfig = await loadTeamConfig();
    const config = {
      ...getFullConfig(),
      saved_template: teamConfig?.template,
      saved_goal: teamConfig?.goal,
      saved_worker_url: teamConfig?.worker_url,
      generation: currentSessionState.generation,
      is_running: currentSessionState.isRunning,
    };
    socket.send(JSON.stringify({ type: "init", config }));
  });

  // Register SPA fallback AFTER all API/WS routes so backend endpoints keep priority.
  if (clientDir) {
    fastify.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET") return reply.status(404).send();
      if (request.url.startsWith("/api") || request.url.startsWith("/ws")) {
        return reply.status(404).send();
      }
      return reply.sendFile("index.html", clientDir);
    });
  }

  try {
    await fastify.listen({ port, host: "0.0.0.0" });
    if (s) {
      const url = `http://localhost:${port}`;
      s.stop("✅ Web Server is live!");
      note(`Access the dashboard at: ${url}`, "TeamClaw Web UI");
    } else {
      logger.success(`Web UI: http://localhost:${port}`);
    }
  } catch (err) {
    if (s) {
      s.stop(`❌ Web server failed to start: ${String(err)}`);
    }
    throw err;
  }
}
