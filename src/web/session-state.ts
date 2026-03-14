/**
 * Shared session state and WebSocket broadcasting for the web UI.
 */

import WebSocket from "ws";
import { CONFIG, type SessionConfig } from "../core/config.js";
import { getModelConfig } from "../core/model-config.js";

export const clients = new Set<WebSocket>();

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
};

export function broadcast(event: object): void {
  const data = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function updateSessionState(updates: Partial<SessionState>): void {
  currentSessionState = { ...currentSessionState, ...updates };
}

export function sendStateSync(socket: WebSocket): void {
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
        generationProgress: currentSessionState.generationProgress,
        cycleProgress: currentSessionState.cycleProgress,
        pendingApproval: currentSessionState.pendingApproval,
      },
    })
  );
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
