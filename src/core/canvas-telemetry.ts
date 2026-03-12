/**
 * OpenClaw Canvas Telemetry - Pushes TeamClaw state changes to OpenClaw Canvas.
 * Uses Gateway WebSocket to emit events that the Canvas UI can display.
 */

import { CONFIG } from "../core/config.js";
import { logger } from "../core/logger.js";
import { wsManager } from "./ws-manager.js";
import type { WsEvent } from "../interfaces/ws-events.js";

export interface TaskEvent {
    task_id: string;
    status: "pending" | "in_progress" | "reviewing" | "completed" | "failed" | "needs_rework";
    description: string;
    assigned_to: string;
    cycle: number;
}

export class CanvasTelemetry {
    private connected = false;
    private unsubscribeMessage: (() => void) | null = null;
    private readonly gatewayUrl: string;

    constructor() {
        const rawUrl = CONFIG.openclawWorkerUrl ?? "http://localhost:18789";
        const hasScheme = /^wss?:\/\//i.test(rawUrl);
        const baseUrl = hasScheme ? rawUrl : `ws://${rawUrl.replace(/^http/i, "ws")}`;
        
        const token = CONFIG.openclawToken ?? "";
        const url = new URL(baseUrl);
        if (token) {
            url.searchParams.set("token", token);
        }

        this.gatewayUrl = url.href;
    }

    async connect(): Promise<boolean> {
        if (this.connected) {
            return true;
        }

        this.unsubscribeMessage?.();
        this.unsubscribeMessage = wsManager.onMessage((raw) => {
            if (!raw || typeof raw !== "object") return;
            const msg = raw as Record<string, unknown>;
            if (msg["type"] === "auth" && msg["status"] === "ok") {
                logger.agent("📡 Canvas telemetry authenticated");
            }
        });

        const ok = await wsManager.connect(this.gatewayUrl);
        this.connected = ok;
        if (ok) {
            logger.agent("📡 Connected to OpenClaw Gateway for Canvas telemetry");
        }
        return ok;
    }

    private emitTelemetry(payload: Record<string, unknown>): void {
        const event: WsEvent = {
            type: "telemetry",
            payload,
        };
        wsManager.send(event);
    }

    send(event: TaskEvent): void {
        this.emitTelemetry({
            event: "teamclaw_task_event",
            ...event,
            timestamp: new Date().toISOString(),
            source: "teamclaw",
        });
    }

    sendTaskStatus(taskId: string, status: TaskEvent["status"], description: string, assignedTo: string, cycle: number): void {
        this.send({
            task_id: taskId,
            status,
            description,
            assigned_to: assignedTo,
            cycle
        });
    }

    sendCycleStart(cycle: number, totalTasks: number): void {
        this.emitTelemetry({
            event: "teamclaw_cycle_start",
            cycle,
            total_tasks: totalTasks,
            timestamp: new Date().toISOString(),
            source: "teamclaw",
        });
    }

    sendSessionStart(goal: string): void {
        this.emitTelemetry({
            event: "teamclaw_session_start",
            goal,
            timestamp: new Date().toISOString(),
            source: "teamclaw",
        });
    }

    disconnect(): void {
        this.unsubscribeMessage?.();
        this.unsubscribeMessage = null;
        this.connected = false;
        wsManager.close();
    }
}

let telemetryInstance: CanvasTelemetry | null = null;

export function getCanvasTelemetry(): CanvasTelemetry {
    if (!telemetryInstance) {
        telemetryInstance = new CanvasTelemetry();
    }
    return telemetryInstance;
}

export async function initCanvasTelemetry(): Promise<boolean> {
    const telemetry = getCanvasTelemetry();
    return await telemetry.connect();
}
