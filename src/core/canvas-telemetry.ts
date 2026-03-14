/**
 * OpenClaw Canvas Telemetry - Pushes TeamClaw state changes to OpenClaw Canvas.
 * Uses Gateway WebSocket to emit events that the Canvas UI can display.
 */

import { CONFIG } from "../core/config.js";
import { logger, isDebugMode } from "../core/logger.js";
import { wsManager } from "./ws-manager.js";
import type { WsEvent } from "../types/ws-events.js";

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
        const baseUrl = rawUrl
            .replace(/^https:\/\//i, "wss://")
            .replace(/^http:\/\//i, "ws://")
            .replace(/^(?!wss?:\/\/)/, "ws://");
        
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
                if (isDebugMode()) logger.agent("📡 Canvas telemetry authenticated");
            }
        });

        const ok = await wsManager.connect(this.gatewayUrl);
        this.connected = ok;
        if (ok && isDebugMode()) {
            logger.agent("📡 Connected to OpenClaw Gateway for Canvas telemetry");
        }
        if (!ok) {
            wsManager.close();
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

    sendPlanningComplete(goal: string, taskCount: number): void {
        this.emitTelemetry({
            event: "teamclaw_planning_complete",
            goal,
            task_count: taskCount,
            timestamp: new Date().toISOString(),
            source: "teamclaw",
        });
    }

    sendRFCEvent(taskId: string, status: "created" | "approved" | "rejected", complexity: string): void {
        this.emitTelemetry({
            event: status === "created" ? "teamclaw_rfc_created" : status === "approved" ? "teamclaw_rfc_approved" : "teamclaw_rfc_rejected",
            task_id: taskId,
            complexity,
            timestamp: new Date().toISOString(),
            source: "teamclaw",
        });
    }

    sendStandup(botId: string, taskId: string, content: string): void {
        this.emitTelemetry({
            event: "teamclaw_standup",
            bot_id: botId,
            task_id: taskId,
            content,
            timestamp: new Date().toISOString(),
            source: "teamclaw",
        });
    }

    sendMidSprint(completedCount: number, totalCount: number, remainingCount: number, vibe: string): void {
        this.emitTelemetry({
            event: "teamclaw_mid_sprint",
            completed: completedCount,
            total: totalCount,
            remaining: remainingCount,
            vibe,
            timestamp: new Date().toISOString(),
            source: "teamclaw",
        });
    }

    sendStreamChunk(taskId: string, botId: string, chunk: string): void {
        this.emitTelemetry({
            event: "STREAM_CHUNK",
            task_id: taskId,
            bot_id: botId,
            chunk,
            timestamp: Date.now(),
            source: "teamclaw",
        });
    }

    sendStreamDone(taskId: string, botId: string, error?: { message: string }): void {
        this.emitTelemetry({
            event: "STREAM_DONE",
            task_id: taskId,
            bot_id: botId,
            error: error ? true : false,
            error_message: error?.message,
            timestamp: Date.now(),
            source: "teamclaw",
        });
    }

    sendWaitingForHuman(taskId: string, message: string): void {
        this.emitTelemetry({
            event: "WAITING_FOR_HUMAN",
            task_id: taskId,
            message,
            timestamp: Date.now(),
            source: "teamclaw",
        });
    }

    sendTokenUsage(inputTokens: number, outputTokens: number, cachedInputTokens: number, model: string): void {
        this.emitTelemetry({
            event: "TOKEN_USAGE",
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_input_tokens: cachedInputTokens,
            model,
            timestamp: Date.now(),
            source: "teamclaw",
        });
    }

    sendReasoning(taskId: string, botId: string, reasoning: string): void {
        this.emitTelemetry({
            event: "REASONING",
            task_id: taskId,
            bot_id: botId,
            reasoning,
            timestamp: Date.now(),
            source: "teamclaw",
        });
    }

    sendNodeActive(nodeName: string): void {
        this.emitTelemetry({
            event: "NODE_ACTIVE",
            node: nodeName,
            timestamp: Date.now(),
            source: "teamclaw",
        });
    }

    sendSessionTimeout(reason: "timeout" | "max_runs", elapsedMs: number): void {
        this.emitTelemetry({
            event: "SESSION_TIMEOUT",
            reason,
            elapsedMs,
            timestamp: Date.now(),
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
