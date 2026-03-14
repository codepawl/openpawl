/**
 * `teamclaw demo` — Synthetic demo mode.
 * Starts a minimal web server and replays scripted pipeline events
 * so the dashboard can be verified without a live OpenClaw gateway.
 */

import Fastify from "fastify";
import FastifyCors from "@fastify/cors";
import FastifyStatic from "@fastify/static";
import FastifyWebSocket from "@fastify/websocket";
import WebSocket from "ws";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAvailablePort } from "../core/port.js";
import { logger } from "../core/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveClientDir(): string | null {
    const candidates = [
        path.join(__dirname, "..", "client"),
        path.join(__dirname, "..", "web", "client", "dist"),
        path.join(__dirname, "..", "web", "client"),
    ];
    for (const p of candidates) {
        if (existsSync(path.join(p, "index.html"))) return p;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Synthetic state & helpers
// ---------------------------------------------------------------------------

const GOAL = "Build a multiplayer quiz game with real-time leaderboard";

const BOTS = ["architect-1", "backend-1", "frontend-1"] as const;

function makeTasks(): Record<string, unknown>[] {
    return [
        { task_id: "task-1", description: "Design WebSocket event schema for real-time quiz sync", assigned_to: "architect-1", status: "pending", priority: "high", urgency: 8, importance: 9, timebox_minutes: 15 },
        { task_id: "task-2", description: "Implement quiz room creation and player join API", assigned_to: "backend-1", status: "pending", priority: "high", urgency: 7, importance: 8, timebox_minutes: 20 },
        { task_id: "task-3", description: "Build leaderboard ranking service with live updates", assigned_to: "backend-1", status: "pending", priority: "medium", urgency: 6, importance: 7, timebox_minutes: 20 },
        { task_id: "task-4", description: "Create React leaderboard component with animations", assigned_to: "frontend-1", status: "pending", priority: "medium", urgency: 5, importance: 7, timebox_minutes: 15 },
        { task_id: "task-5", description: "Integrate quiz timer and answer validation UI", assigned_to: "frontend-1", status: "pending", priority: "low", urgency: 4, importance: 6, timebox_minutes: 15 },
    ];
}

function emptyBotStats(): Record<string, Record<string, unknown>> {
    const stats: Record<string, Record<string, unknown>> = {};
    for (const bot of BOTS) {
        stats[bot] = { tasks_completed: 0, tasks_failed: 0, total_tokens: 0 };
    }
    return stats;
}

interface DemoState {
    cycle_count: number;
    task_queue: Record<string, unknown>[];
    bot_stats: Record<string, Record<string, unknown>>;
    last_quality_score: number;
    agent_messages: unknown[];
    approval_pending: Record<string, unknown> | null;
    approval_response: Record<string, unknown> | null;
}

function buildSnapshot(state: DemoState) {
    const botStats = state.bot_stats;
    const totalDone = Object.values(botStats).reduce(
        (s, x) => s + ((x.tasks_completed as number) ?? 0), 0,
    );
    const totalFailed = Object.values(botStats).reduce(
        (s, x) => s + ((x.tasks_failed as number) ?? 0), 0,
    );
    return {
        cycle: state.cycle_count,
        tasks_completed: totalDone,
        tasks_failed: totalFailed,
        last_quality_score: state.last_quality_score,
        agent_messages: state.agent_messages,
        task_queue: state.task_queue,
        bot_stats: state.bot_stats,
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
        actions.push(
            success
                ? { bot: "sparki", action: "celebrate", delay: 1.5 }
                : { bot: "sparki", action: "react", emotion: "worried", delay: 1.5 },
        );
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

function buildNodeEvent(nodeName: string, data: Record<string, unknown>, state: DemoState) {
    const snapshot = buildSnapshot(state);
    const botActions = getBotActions(nodeName, data);
    return {
        type: "node_event" as const,
        node: nodeName,
        data,
        state: snapshot,
        bot_actions: botActions,
        timestamp: new Date().toTimeString().slice(0, 8),
    };
}

function nodeActiveEvent(node: string) {
    return {
        type: "telemetry",
        payload: { event: "NODE_ACTIVE", node, timestamp: Date.now() },
    };
}

function tokenUsageEvent(input: number, output: number, cached: number) {
    return {
        type: "telemetry",
        payload: {
            event: "TOKEN_USAGE",
            input_tokens: input,
            output_tokens: output,
            cached_input_tokens: cached,
            model: "demo/synthetic",
            timestamp: Date.now(),
        },
    };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Event sequence
// ---------------------------------------------------------------------------

async function runSequence(broadcast: (evt: object) => void): Promise<void> {
    const state: DemoState = {
        cycle_count: 0,
        task_queue: makeTasks(),
        bot_stats: emptyBotStats(),
        last_quality_score: 0,
        agent_messages: [],
        approval_pending: null,
        approval_response: null,
    };

    // Helper to emit a planning-style node
    async function emitPlanningNode(name: string, delayMs: number, message?: string) {
        logger.info(`Demo: simulating ${name}...`);
        const data: Record<string, unknown> = { message: message ?? `${name} executed` };
        broadcast(buildNodeEvent(name, data, state));
        broadcast(nodeActiveEvent(name));
        await sleep(delayMs);
    }

    // Helper to complete a task
    function completeTask(taskId: string, success: boolean, quality: number) {
        const idx = state.task_queue.findIndex((t) => t.task_id === taskId);
        if (idx < 0) return;
        const task = state.task_queue[idx];
        task.status = success ? "completed" : "failed";
        task.result = { success, quality_score: quality, output: success ? "Implementation complete" : "Quality below threshold" };
        const bot = task.assigned_to as string;
        if (state.bot_stats[bot]) {
            if (success) {
                (state.bot_stats[bot].tasks_completed as number) += 1;
            } else {
                (state.bot_stats[bot].tasks_failed as number) += 1;
            }
        }
        state.last_quality_score = quality;
    }

    // Helper to emit worker_execute for a task
    async function emitWorkerExecute(taskId: string, success: boolean, quality: number, delayMs: number) {
        // Set task in_progress first
        const idx = state.task_queue.findIndex((t) => t.task_id === taskId);
        if (idx >= 0) state.task_queue[idx].status = "in_progress";

        logger.info(`Demo: simulating worker_execute (${taskId})...`);
        await sleep(delayMs * 0.3);

        completeTask(taskId, success, quality);
        const task = state.task_queue.find((t) => t.task_id === taskId)!;
        const result = task.result as Record<string, unknown>;
        const data: Record<string, unknown> = {
            task_id: taskId,
            success,
            quality_score: quality,
            assigned_to: task.assigned_to ?? "",
            output: result.output ?? "",
            description: task.description ?? "",
            message: success ? "✅ Task completed" : "❌ Task completed",
            bot_stats: state.bot_stats,
        };
        broadcast(buildNodeEvent("worker_execute", data, state));
        broadcast(nodeActiveEvent("worker_execute"));
        await sleep(delayMs * 0.7);
    }

    // ---- Config + initial events ----
    broadcast({ type: "config_updated", config: { creativity: 0.7, max_cycles: 2, max_generations: 1, worker_url: "demo://synthetic" } });
    await sleep(300);

    // ==== CYCLE 1 ====
    state.cycle_count = 1;
    broadcast({ type: "cycle_start", cycle: 1, max_cycles: 2 });
    logger.info("Demo: --- Cycle 1 ---");
    await sleep(500);

    // Planning nodes
    await emitPlanningNode("memory_retrieval", 800, "Retrieved 3 prior lessons from vector memory");
    await emitPlanningNode("sprint_planning", 1200, "Sprint planned: 5 tasks across 3 bots");
    await emitPlanningNode("system_design", 1500, "System architecture: WebSocket + REST hybrid");
    await emitPlanningNode("rfc_phase", 1000, "RFC approved: event-driven leaderboard design");

    // Coordinator assigns tasks 1,2
    logger.info("Demo: simulating coordinator...");
    state.task_queue[0].status = "in_progress";
    state.task_queue[1].status = "in_progress";
    const coordData1: Record<string, unknown> = {
        message: "Coordinator processed, 3 tasks pending",
        pending_count: 3,
    };
    broadcast(buildNodeEvent("coordinator", coordData1, state));
    broadcast(nodeActiveEvent("coordinator"));
    await sleep(800);

    // Worker executes task-1 (success)
    await emitWorkerExecute("task-1", true, 0.92, 2000);

    // Worker executes task-2 (success)
    await emitWorkerExecute("task-2", true, 0.88, 1800);

    // Approval phase
    logger.info("Demo: simulating approval...");
    state.approval_pending = {
        task_id: "task-1",
        description: "Review WebSocket event schema design before proceeding",
        type: "quality_gate",
    };
    broadcast({
        type: "approval_request",
        pending: state.approval_pending,
    });
    const approvalData: Record<string, unknown> = {
        message: "Awaiting approval",
        approval_pending: state.approval_pending,
        approval_response: null,
    };
    broadcast(buildNodeEvent("approval", approvalData, state));
    broadcast(nodeActiveEvent("approval"));
    await sleep(3000);

    // Auto-resolve approval
    state.approval_response = { action: "approved" };
    state.approval_pending = null;
    const approvalResolvedData: Record<string, unknown> = {
        message: "Approval: approved",
        approval_pending: null,
        approval_response: state.approval_response,
    };
    broadcast(buildNodeEvent("approval", approvalResolvedData, state));
    await sleep(500);

    // Token usage telemetry
    broadcast(tokenUsageEvent(12400, 3200, 1800));
    await sleep(300);

    // Increment cycle
    logger.info("Demo: simulating increment_cycle...");
    const cycleData1: Record<string, unknown> = {
        cycle: 1,
        message: "Cycle 1 completed",
    };
    broadcast(buildNodeEvent("increment_cycle", cycleData1, state));
    broadcast(nodeActiveEvent("increment_cycle"));
    await sleep(800);

    // ==== CYCLE 2 ====
    state.cycle_count = 2;
    broadcast({ type: "cycle_start", cycle: 2, max_cycles: 2 });
    logger.info("Demo: --- Cycle 2 ---");
    await sleep(500);

    // Planning nodes (shorter)
    await emitPlanningNode("memory_retrieval", 500, "Retrieved 3 prior lessons from vector memory");
    await emitPlanningNode("sprint_planning", 700, "Sprint adjusted: 3 remaining tasks");
    await emitPlanningNode("system_design", 800, "Design validated, no changes needed");
    await emitPlanningNode("rfc_phase", 600, "RFC: incremental update approved");

    // Coordinator assigns tasks 3,4,5
    logger.info("Demo: simulating coordinator...");
    state.task_queue[2].status = "in_progress";
    state.task_queue[3].status = "in_progress";
    state.task_queue[4].status = "in_progress";
    const coordData2: Record<string, unknown> = {
        message: "Coordinator processed, 0 tasks pending",
        pending_count: 0,
    };
    broadcast(buildNodeEvent("coordinator", coordData2, state));
    broadcast(nodeActiveEvent("coordinator"));
    await sleep(800);

    // Worker executes task-3 (success)
    await emitWorkerExecute("task-3", true, 0.85, 1500);

    // Worker executes task-4 (FAIL)
    await emitWorkerExecute("task-4", false, 0.35, 1200);

    // Worker executes task-5 (success)
    await emitWorkerExecute("task-5", true, 0.91, 1400);

    // Cumulative token usage
    broadcast(tokenUsageEvent(24800, 6100, 4200));
    await sleep(300);

    // Increment cycle
    logger.info("Demo: simulating increment_cycle...");
    const cycleData2: Record<string, unknown> = {
        cycle: 2,
        message: "Cycle 2 completed",
    };
    broadcast(buildNodeEvent("increment_cycle", cycleData2, state));
    broadcast(nodeActiveEvent("increment_cycle"));
    await sleep(500);

    // Session complete
    broadcast({ type: "session_complete" });
    broadcast(nodeActiveEvent("completed"));
    logger.info("Demo: sequence finished.");
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

export async function runDemo(args: string[]): Promise<void> {
    let requestedPort = 8000;
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) {
            requestedPort = parseInt(args[i + 1], 10) || 8000;
            i++;
        }
    }
    const port = await findAvailablePort(requestedPort);
    if (port !== requestedPort) {
        logger.info(`Port ${requestedPort} in use, using ${port}`);
    }

    const clients = new Set<WebSocket>();

    function broadcast(event: object): void {
        const data = JSON.stringify(event);
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    const fastify = Fastify({ logger: false });
    await fastify.register(FastifyCors, { origin: "*" });

    const clientDir = resolveClientDir();
    if (clientDir) {
        await fastify.register(FastifyStatic, {
            root: clientDir,
            index: ["index.html"],
            wildcard: false,
        });
    } else {
        logger.warn("Web client build not found. Run `pnpm run client:build` first.");
    }

    await fastify.register(FastifyWebSocket);

    // Track latest state for state_sync on new connections
    let latestSnapshot: Record<string, unknown> = {
        activeNode: null,
        cycle: 0,
        taskQueue: [],
        botStats: {},
        isRunning: true,
        generation: 1,
    };

    // Wrap broadcast to also track state
    const originalBroadcast = broadcast;
    function trackingBroadcast(event: object): void {
        const evt = event as Record<string, unknown>;
        if (evt.type === "node_event") {
            const state = evt.state as Record<string, unknown> | undefined;
            if (state) {
                latestSnapshot = {
                    activeNode: evt.node ?? null,
                    cycle: state.cycle ?? 0,
                    taskQueue: state.task_queue ?? [],
                    botStats: state.bot_stats ?? {},
                    isRunning: true,
                    generation: 1,
                };
            }
        } else if (evt.type === "session_complete") {
            latestSnapshot = { ...latestSnapshot, isRunning: false, activeNode: null };
        }
        originalBroadcast(event);
    }

    fastify.get("/ws", { websocket: true }, async (socket) => {
        clients.add(socket);

        // Send state_sync so late-connecting clients see current state
        socket.send(JSON.stringify({ type: "state_sync", state: latestSnapshot }));

        // Send init with demo config
        socket.send(JSON.stringify({
            type: "init",
            config: {
                creativity: 0.7,
                max_cycles: 2,
                max_generations: 1,
                worker_url: "demo://synthetic",
                saved_goal: GOAL,
                saved_template: "game_dev",
                generation: 1,
                is_running: true,
            },
        }));

        socket.on("close", () => clients.delete(socket));
        socket.on("error", () => clients.delete(socket));
    });

    // SPA fallback
    if (clientDir) {
        fastify.setNotFoundHandler((request, reply) => {
            if (request.method !== "GET") return reply.status(404).send();
            if (request.url.startsWith("/api") || request.url.startsWith("/ws")) {
                return reply.status(404).send();
            }
            return reply.sendFile("index.html", clientDir);
        });
    }

    await fastify.listen({ port, host: "0.0.0.0" });
    const url = `http://localhost:${port}`;
    logger.success(`Demo server live at ${url}`);
    logger.info("Waiting 2s for browser connections...");
    await sleep(2000);

    // Run the synthetic event sequence
    await runSequence(trackingBroadcast);

    logger.success(`Demo complete. Dashboard at ${url} — Ctrl+C to exit.`);

    // Keep process alive
    await new Promise<void>(() => {});
}
