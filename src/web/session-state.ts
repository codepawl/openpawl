/**
 * Shared session state and SSE broadcasting for the web UI.
 */

import type { ServerResponse } from "node:http";
import type { ApprovalPending, ApprovalResponse } from "../agents/approval.js";
import type { PreviewState, PreviewResponse } from "../graph/preview/types.js";
import type { PartialApprovalTask, PartialApprovalDecision } from "../agents/partial-approval.js";
import { CONFIG, type SessionConfig } from "../core/config.js";
import { getModelConfig } from "../core/model-config.js";

// ---------------------------------------------------------------------------
// SSE client management
// ---------------------------------------------------------------------------
export interface SseClient {
  id: string;
  res: ServerResponse;
}

export const sseClients = new Set<SseClient>();
let eventCounter = 0;

interface ReplayEntry {
  id: number;
  data: string;
}
const replayBuffer: ReplayEntry[] = [];
const REPLAY_BUFFER_MAX = 200;

function writeEvent(res: ServerResponse, id: number, data: string): void {
  try {
    res.write(`id: ${id}\ndata: ${data}\n\n`);
  } catch {
    // client may have disconnected
  }
}

export function broadcast(event: object): void {
  eventCounter++;
  const data = JSON.stringify(event);
  replayBuffer.push({ id: eventCounter, data });
  if (replayBuffer.length > REPLAY_BUFFER_MAX) {
    replayBuffer.shift();
  }
  for (const client of sseClients) {
    writeEvent(client.res, eventCounter, data);
  }
}

export function addSseClient(client: SseClient, lastEventId?: number): void {
  // Replay missed events
  if (lastEventId != null && lastEventId > 0) {
    const startIdx = replayBuffer.findIndex((e) => e.id > lastEventId);
    if (startIdx >= 0) {
      for (let i = startIdx; i < replayBuffer.length; i++) {
        writeEvent(client.res, replayBuffer[i].id, replayBuffer[i].data);
      }
    }
  }
  sseClients.add(client);
}

export function removeSseClient(client: SseClient): void {
  sseClients.delete(client);
}

/** Timestamp when this server process started — used by the client to detect restarts. */
export const SERVER_START_TS = Date.now();

export interface SessionState {
  activeNode: string | null;
  cycle: number;
  taskQueue: Record<string, unknown>[];
  botStats: Record<string, Record<string, unknown>>;
  isRunning: boolean;
  generation: number;
  generationProgress: { generation: number; maxGenerations: number; lessonsCount: number; startedAt: number } | null;
  cycleProgress: { cycle: number; maxCycles: number; startedAt: number } | null;
  pendingApproval: Record<string, unknown> | null;
  gatewayAvailable: boolean;
}

export let currentSessionState: SessionState = {
  activeNode: null,
  cycle: 0,
  taskQueue: [],
  botStats: {},
  isRunning: false,
  generation: 0,
  generationProgress: null,
  cycleProgress: null,
  pendingApproval: null,
  gatewayAvailable: true,
};

export function updateSessionState(updates: Partial<SessionState>): void {
  currentSessionState = { ...currentSessionState, ...updates };
}

// ---------------------------------------------------------------------------
// Global session control (replaces per-WS-connection ctrl)
// ---------------------------------------------------------------------------
export interface SessionControl {
  speedFactor: number;
  paused: boolean;
  cancelled: boolean;
}

export const sessionControl: SessionControl = {
  speedFactor: 1.0,
  paused: true,
  cancelled: false,
};

export function resetSessionControl(): void {
  sessionControl.speedFactor = 1.0;
  sessionControl.paused = true;
  sessionControl.cancelled = false;
}

// ---------------------------------------------------------------------------
// Global approval resolver (replaces per-WS-connection closure)
// ---------------------------------------------------------------------------
let approvalResolve: ((r: ApprovalResponse) => void) | null = null;

export function getApprovalResolve(): ((r: ApprovalResponse) => void) | null {
  return approvalResolve;
}

export function setApprovalResolve(fn: ((r: ApprovalResponse) => void) | null): void {
  approvalResolve = fn;
}

export function approvalProvider(pending: ApprovalPending): Promise<ApprovalResponse> {
  return new Promise((resolve) => {
    approvalResolve = resolve;
    broadcast({ type: "approval_request", pending });
    updateSessionState({ pendingApproval: pending as unknown as Record<string, unknown> });
  });
}

// ---------------------------------------------------------------------------
// Preview resolver (same pattern as approval)
// ---------------------------------------------------------------------------
let previewResolve: ((r: PreviewResponse) => void) | null = null;

export function getPreviewResolve(): ((r: PreviewResponse) => void) | null {
  return previewResolve;
}

export function setPreviewResolve(fn: ((r: PreviewResponse) => void) | null): void {
  previewResolve = fn;
}

export function previewProvider(preview: PreviewState): Promise<PreviewResponse> {
  return new Promise((resolve) => {
    previewResolve = resolve;
    broadcast({ type: "preview_request", preview });
  });
}

// ---------------------------------------------------------------------------
// Per-task partial approval resolvers (dashboard → partial_approval node)
// ---------------------------------------------------------------------------
const taskApprovalResolvers = new Map<string, (r: PartialApprovalDecision) => void>();

export function setTaskApprovalResolver(taskId: string, fn: (r: PartialApprovalDecision) => void): void {
  taskApprovalResolvers.set(taskId, fn);
}

export function getTaskApprovalResolver(taskId: string): ((r: PartialApprovalDecision) => void) | null {
  return taskApprovalResolvers.get(taskId) ?? null;
}

export function clearTaskApprovalResolver(taskId: string): void {
  taskApprovalResolvers.delete(taskId);
}

export function clearAllTaskApprovalResolvers(): void {
  taskApprovalResolvers.clear();
}

export function partialApprovalProvider(tasks: PartialApprovalTask[]): Promise<Map<string, PartialApprovalDecision>> {
  return new Promise((resolve) => {
    const decisions = new Map<string, PartialApprovalDecision>();
    let remaining = tasks.filter((t) => !t.is_auto_approved).length;

    // If all tasks are auto-approved, resolve immediately
    if (remaining <= 0) {
      for (const task of tasks) {
        decisions.set(task.task_id, { action: "approve" });
      }
      resolve(decisions);
      return;
    }

    for (const task of tasks) {
      if (task.is_auto_approved) {
        // Auto-approved tasks default to approve, but can be overridden
        decisions.set(task.task_id, { action: "approve" });
      }
      setTaskApprovalResolver(task.task_id, (decision) => {
        decisions.set(task.task_id, decision);
        // Only count manual tasks toward the remaining counter
        if (!task.is_auto_approved) {
          remaining--;
        }
        if (remaining <= 0) {
          clearAllTaskApprovalResolvers();
          resolve(decisions);
        }
      });
    }

    broadcast({ type: "partial_approval_request", tasks });
    updateSessionState({ pendingApproval: { type: "partial", tasks } as unknown as Record<string, unknown> });
  });
}

// ---------------------------------------------------------------------------
// CLI-level config state (mutable, lives for server lifetime)
// ---------------------------------------------------------------------------
export let cliCycles = CONFIG.maxCycles;
export let cliGenerations = CONFIG.maxRuns;
export let cliCreativity = CONFIG.creativity;
export let cliSessionMode: "runs" | "time" = "runs";
export let cliSessionDuration = 30;

export function getFullConfig(): Record<string, unknown> {
  const modelCfg = getModelConfig();
  return {
    creativity: cliCreativity,
    max_cycles: cliCycles,
    max_generations: cliGenerations,
    session_mode: cliSessionMode,
    session_duration: cliSessionDuration,
    worker_url: CONFIG.openclawWorkerUrl || "",
    model: CONFIG.openclawModel || modelCfg.defaultModel,
    agent_models: modelCfg.agentModels,
    fallback_chain: modelCfg.fallbackChain,
  };
}

export function applyConfigOverrides(overrides: Partial<SessionConfig> & Record<string, unknown>): void {
  if (typeof overrides.max_cycles === "number") cliCycles = overrides.max_cycles;
  if (typeof overrides.max_generations === "number") cliGenerations = overrides.max_generations;
  if (typeof overrides.creativity === "number")
    cliCreativity = Math.max(0, Math.min(1, overrides.creativity));
  if (overrides.session_mode === "runs" || overrides.session_mode === "time")
    cliSessionMode = overrides.session_mode;
  if (typeof overrides.session_duration === "number")
    cliSessionDuration = Math.max(1, Math.floor(overrides.session_duration));
}
