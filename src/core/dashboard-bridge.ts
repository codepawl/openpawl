/**
 * Dashboard Bridge - Forwards orchestration events to the TeamClaw web dashboard.
 * Used by work-runner to push state updates when the dashboard runs as a separate daemon.
 */

import WebSocket from "ws";
import { logger, isDebugMode } from "./logger.js";
import { coordinatorEvents, type CoordinatorStep } from "./coordinator-events.js";
import { workerEvents, type WorkerProgressStep, type WorkerReasoningStep } from "./worker-events.js";
import { openclawEvents, type OpenClawLogEntry, type OpenClawStreamChunk } from "./openclaw-events.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TERMINAL_BATCH_MS = 50;

export class DashboardBridge {
    private ws: WebSocket | null = null;
    private connected = false;
    private port: number;

    private coordinatorListener: ((data: CoordinatorStep) => void) | null = null;
    private workerListener: ((data: WorkerProgressStep) => void) | null = null;
    private reasoningListener: ((data: WorkerReasoningStep) => void) | null = null;
    private openclawLogListener: ((entry: OpenClawLogEntry) => void) | null = null;
    private streamChunkListener: ((chunk: OpenClawStreamChunk) => void) | null = null;

    // Terminal forwarding state
    private terminalBuffer: string[] = [];
    private terminalFlushScheduled = false;
    private stdoutOriginal: ((chunk: any, ...args: any[]) => boolean) | null = null;
    private stderrOriginal: ((chunk: any, ...args: any[]) => boolean) | null = null;

    constructor(port: number) {
        this.port = port;
        this.coordinatorListener = (data: CoordinatorStep) => {
            this.relay({
                type: "node_event",
                node: "coordinator",
                data: { message: data.detail, step: data.step },
                state: {},
                timestamp: new Date().toTimeString().slice(0, 8),
            });
        };
        coordinatorEvents.on("progress", this.coordinatorListener);

        this.workerListener = (data: WorkerProgressStep) => {
            this.relay({
                type: "task_queue_updated",
                task_queue: data.taskQueue,
            });
        };
        workerEvents.on("progress", this.workerListener);

        this.reasoningListener = (data: WorkerReasoningStep) => {
            this.relay({
                type: "telemetry",
                payload: {
                    event: "REASONING",
                    task_id: data.taskId,
                    bot_id: data.botId,
                    reasoning: data.reasoning,
                    timestamp: Date.now(),
                    source: "teamclaw",
                },
            });
        };
        workerEvents.on("reasoning", this.reasoningListener);

        this.openclawLogListener = (entry: OpenClawLogEntry) => {
            this.relay({ type: "openclaw_log", entry });
        };
        openclawEvents.on("log", this.openclawLogListener);

        this.streamChunkListener = (data: OpenClawStreamChunk) => {
            this.relay({
                type: "telemetry",
                payload: {
                    event: "STREAM_CHUNK",
                    bot_id: data.botId,
                    model: data.model,
                    chunk: data.chunk,
                    timestamp: data.timestamp,
                },
            });
        };
        openclawEvents.on("stream_chunk", this.streamChunkListener);
    }

    async connect(): Promise<boolean> {
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            return true;
        }

        // Retry with backoff — daemon may not have its WS server ready yet
        for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) {
                await new Promise((r) => setTimeout(r, 500 * attempt));
            }
            const ok = await this.tryConnect();
            if (ok) return true;
        }
        return false;
    }

    private tryConnect(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const url = `ws://localhost:${this.port}/ws`;
            try {
                this.ws = new WebSocket(url);
            } catch {
                this.connected = false;
                resolve(false);
                return;
            }

            const timeout = setTimeout(() => {
                this.ws?.terminate();
                this.connected = false;
                resolve(false);
            }, 3000);

            this.ws.on("open", () => {
                clearTimeout(timeout);
                this.connected = true;
                if (isDebugMode()) logger.agent("Dashboard bridge connected");
                resolve(true);
            });

            this.ws.on("error", () => {
                clearTimeout(timeout);
                this.connected = false;
                resolve(false);
            });

            this.ws.on("close", () => {
                this.connected = false;
            });
        });
    }

    /** Intercept stdout/stderr in this process and forward terminal output to the dashboard. */
    startTerminalForwarding(): void {
        if (this.stdoutOriginal) return; // already intercepting
        this.stdoutOriginal = process.stdout.write.bind(process.stdout) as (chunk: any, ...args: any[]) => boolean;
        this.stderrOriginal = process.stderr.write.bind(process.stderr) as (chunk: any, ...args: any[]) => boolean;

        const self = this;
        const makeInterceptor = (
            original: (chunk: any, ...args: any[]) => boolean,
        ): ((chunk: any, ...args: any[]) => boolean) => {
            return function (chunk: any, ...args: any[]): boolean {
                const result = original(chunk, ...args);
                const str = typeof chunk === "string" ? chunk : String(chunk);
                if (str) self.bufferTerminalData(str);
                return result;
            };
        };

        process.stdout.write = makeInterceptor(this.stdoutOriginal) as typeof process.stdout.write;
        process.stderr.write = makeInterceptor(this.stderrOriginal!) as typeof process.stderr.write;
    }

    private stopTerminalForwarding(): void {
        if (this.stdoutOriginal) {
            process.stdout.write = this.stdoutOriginal as typeof process.stdout.write;
            this.stdoutOriginal = null;
        }
        if (this.stderrOriginal) {
            process.stderr.write = this.stderrOriginal as typeof process.stderr.write;
            this.stderrOriginal = null;
        }
    }

    private bufferTerminalData(data: string): void {
        if (!this.connected) return;
        this.terminalBuffer.push(data);
        if (!this.terminalFlushScheduled) {
            this.terminalFlushScheduled = true;
            setTimeout(() => this.flushTerminalBuffer(), TERMINAL_BATCH_MS);
        }
    }

    private flushTerminalBuffer(): void {
        this.terminalFlushScheduled = false;
        if (this.terminalBuffer.length === 0) return;
        const data = this.terminalBuffer.join("");
        this.terminalBuffer.length = 0;
        this.relay({ type: "terminal_out", payload: { data } });
    }

    /** Send a bridge_relay command so the server broadcasts the event to browser clients. */
    private relay(event: Record<string, unknown>): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        try {
            this.ws.send(JSON.stringify({
                type: "system",
                payload: {
                    command: "bridge_relay",
                    event,
                },
            }));
        } catch {
            // Best-effort
        }
    }

    sendNodeEvent(nodeName: string, state: Record<string, unknown>): void {
        const botStats = (state.bot_stats ?? {}) as Record<string, Record<string, unknown>>;
        const totalDone = Object.values(botStats).reduce(
            (s, x) => s + ((x?.tasks_completed as number) ?? 0),
            0,
        );
        const totalFailed = Object.values(botStats).reduce(
            (s, x) => s + ((x?.tasks_failed as number) ?? 0),
            0,
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
                    ["completed", "failed"].includes((t.status as string) ?? ""),
                ) ?? {};
            const result = ((lastTask as Record<string, unknown>).result ?? {}) as Record<string, unknown>;
            data = {
                task_id: (lastTask as Record<string, unknown>).task_id ?? "",
                success: result.success ?? false,
                quality_score: result.quality_score ?? 0,
                assigned_to: (lastTask as Record<string, unknown>).assigned_to ?? "",
                output: result.output ?? "",
                description: (lastTask as Record<string, unknown>).description ?? "",
                message: result.success ? "✅ Task completed" : "❌ Task completed",
                bot_stats: state.bot_stats ?? {},
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

        this.relay({
            type: "node_event",
            node: nodeName,
            data,
            state: snapshot,
            bot_actions: botActions,
            timestamp: new Date().toTimeString().slice(0, 8),
        });

        // Also send telemetry NODE_ACTIVE so the client updates the active node indicator
        this.relay({
            type: "telemetry",
            payload: {
                event: "NODE_ACTIVE",
                node: nodeName,
                timestamp: Date.now(),
            },
        });
    }

    sendCycleStart(cycle: number, maxCycles: number): void {
        this.relay({ type: "cycle_start", cycle, max_cycles: maxCycles });
    }

    sendSessionComplete(): void {
        this.relay({ type: "session_complete" });
        this.relay({
            type: "telemetry",
            payload: { event: "NODE_ACTIVE", node: "completed", timestamp: Date.now() },
        });
    }

    sendError(message: string): void {
        this.relay({ type: "error", message });
    }

    disconnect(): void {
        this.stopTerminalForwarding();
        if (this.coordinatorListener) {
            coordinatorEvents.off("progress", this.coordinatorListener);
            this.coordinatorListener = null;
        }
        if (this.workerListener) {
            workerEvents.off("progress", this.workerListener);
            this.workerListener = null;
        }
        if (this.reasoningListener) {
            workerEvents.off("reasoning", this.reasoningListener);
            this.reasoningListener = null;
        }
        if (this.openclawLogListener) {
            openclawEvents.off("log", this.openclawLogListener);
            this.openclawLogListener = null;
        }
        if (this.streamChunkListener) {
            openclawEvents.off("stream_chunk", this.streamChunkListener);
            this.streamChunkListener = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }
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

let bridgeInstance: DashboardBridge | null = null;

export function getDashboardBridge(): DashboardBridge {
    if (!bridgeInstance) {
        throw new Error("Dashboard bridge not initialized. Call initDashboardBridge() first.");
    }
    return bridgeInstance;
}

export async function initDashboardBridge(port: number): Promise<boolean> {
    bridgeInstance = new DashboardBridge(port);
    return bridgeInstance.connect();
}
