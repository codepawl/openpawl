/**
 * Fastify server for TeamClaw web UI.
 * Serves static HTML and streams workflow events via WebSocket.
 */

import Fastify from "fastify";
import FastifyCors from "@fastify/cors";
import FastifyStatic from "@fastify/static";
import FastifyWebSocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isProduction = process.env.NODE_ENV === "production";
const CLIENT_DIR = path.join(__dirname, "client");

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
  socket: { send: (data: string) => unknown };
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
        entry.socket.send(
          JSON.stringify({
            type: "task_queue_updated",
            task_queue: updatedQueue,
          })
        );
        entry.socket.send(
          JSON.stringify({
            type: "timeout_alert",
            task_queue: updatedQueue,
          })
        );
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

export async function runWeb(args: string[]): Promise<void> {
  startTimeoutChecker();
  const result = await validateStartup({ templateId: "game_dev" });
  if (!result.ok) {
    logger.error(result.message);
    process.exit(1);
  }

  await ensureWorkspaceDir(CONFIG.workspaceDir);

  let port = 8000;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) {
      port = parseInt(args[i + 1], 10) || 8000;
      i++;
    }
  }

  const fastify = Fastify({ logger: false });
  await fastify.register(FastifyCors, {
    origin: isProduction ? false : "http://localhost:5173",
  });

  if (isProduction) {
    await fastify.register(FastifyStatic, { root: CLIENT_DIR, index: ["index.html"] });
    fastify.setNotFoundHandler((request, reply) => {
      if (request.method !== "GET") return reply.status(404).send();
      if (request.url.startsWith("/api") || request.url.startsWith("/ws"))
        return reply.status(404).send();
      return reply.sendFile("index.html", CLIENT_DIR);
    });
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
    const vectorMemory = new VectorMemory(CONFIG.chromadbPersistDir);
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
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }

      const cmd = msg.command;
      if (cmd === "pause") ctrl.paused = true;
      else if (cmd === "resume") ctrl.paused = false;
      else if (cmd === "speed") {
        const v = Number(msg.value ?? 1);
        ctrl.speedFactor = Math.max(0.25, Math.min(5, v));
      } else if (cmd === "config") {
        applyConfigOverrides((msg.values as Record<string, unknown>) ?? {});
        socket.send(
          JSON.stringify({ type: "config_updated", config: getFullConfig() })
        );
      } else if (cmd === "cancel") {
        ctrl.cancelled = true;
        ctrl.paused = false;
      } else if (cmd === "approval_response") {
        const action = (msg.action as string) ?? "approved";
        const payload = msg as Record<string, unknown>;
        if (approvalResolve) {
          approvalResolve({
            action: action as ApprovalResponse["action"],
            edited_task: payload.edited_task as { description: string } | undefined,
            feedback: payload.feedback as string | undefined,
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
          socket.send(JSON.stringify({ type: "task_queue_updated", task_queue: updatedQueue }));
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
          "Build a small 2D game with sprite assets and sound effects";
        const teamTemplate =
          (msg.team_template as string) ?? teamConfig?.template ?? "game_dev";
        const workerUrlOverride = (msg.worker_url as string)?.trim() || undefined;

        socket.send(
          JSON.stringify({ type: "config_updated", config: getFullConfig() })
        );

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
            socket.send(
              JSON.stringify({
                type: "provision_error",
                error: "❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function.",
              })
            );
            return;
          }
          const provisionResult = await provisionOpenClaw({ workerUrl: openclawUrl });
          if (!provisionResult.ok) {
            const detail = provisionResult.error ?? "unknown error";
            logger.warn(`OpenClaw provisioning failed: ${detail}`);
            socket.send(
              JSON.stringify({
                type: "provision_error",
                error: `❌ OpenClaw Gateway not found. TeamClaw requires OpenClaw to function. Details: ${detail}`,
              })
            );
            return;
          }

          const vectorMemory = new VectorMemory(CONFIG.chromadbPersistDir);
          await vectorMemory.init();
          const analyst = new PostMortemAnalyst(vectorMemory);

          for (let genId = 1; genId <= cliGenerations; genId++) {
            if (ctrl.cancelled) break;

            const priorLessons = await vectorMemory.getCumulativeLessons();
            socket.send(
              JSON.stringify({
                type: "generation_start",
                generation: genId,
                max_generations: cliGenerations,
                lessons_count: priorLessons.length,
              })
            );

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
            THREAD_REGISTRY.set(runThreadId, { orch, socket });
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
                  socket.send(
                    JSON.stringify({
                      type: "cycle_start",
                      cycle,
                      max_cycles: cliCycles,
                    })
                  );
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
                socket.send(JSON.stringify({ type: "node_event", ...parsed }));

                await new Promise((r) =>
                  setTimeout(r, 300 / ctrl.speedFactor)
                );
              }
            } catch (err) {
              socket.send(
                JSON.stringify({ type: "error", message: String(err) })
              );
              break;
            }

            if (ctrl.cancelled) {
              socket.send(JSON.stringify({ type: "session_cancelled" }));
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
            socket.send(
              JSON.stringify({
                type: "generation_end",
                generation: genId,
                outcome,
                final_state: fs,
                gen_summary: { outcome, final_state: fs },
              })
            );

            await new Promise((r) => setTimeout(r, 1000));
          }

          if (!ctrl.cancelled) {
            socket.send(JSON.stringify({ type: "session_complete" }));
          }
          if (runThreadId) {
            THREAD_REGISTRY.delete(runThreadId);
          }
          runThreadId = null;
          currentOrch = null;
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
    };
    socket.send(JSON.stringify({ type: "init", config }));
  });

  let bound = false;
  while (!bound) {
    try {
      await fastify.listen({ port, host: "0.0.0.0" });
      logger.success(`Web UI: http://localhost:${port}`);
      bound = true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EADDRINUSE") {
        const suggestedPort = port + 1;
        const answer = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question(
            `Port ${port} is in use. Enter new port [${suggestedPort}]: `,
            (a) => {
              rl.close();
              resolve(a.trim());
            }
          );
        });
        const parsed = answer ? parseInt(answer, 10) : suggestedPort;
        port =
          Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535
            ? parsed
            : suggestedPort;
      } else {
        throw err;
      }
    }
  }
}
